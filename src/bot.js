import { helpText, parseCommand, pingText } from "./commands.js";
import { SEARCH_SYSTEM_HINT, SEARCH_TOOL, formatSearchResults } from "./search.js";
import { WEATHER_SYSTEM_HINT, WEATHER_TOOL } from "./weather.js";
import { NEWS_SYSTEM_HINT, NEWS_TOOL, formatNews } from "./news.js";
import { looksLikePersonaInstruction } from "./persona.js";

const MAX_INPUT_CHARS = 4000;

function extractText(d) {
  let text = String(d.content ?? "").trim();
  if (!text && Array.isArray(d.msg_elements)) {
    text = d.msg_elements
      .map((element) => String(element?.content ?? "").trim())
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  // 全量模式下 @成员 会被替换成 <@member_openid>，@全体 是 <@all>；
  // 表情/图片等非文本消息会带 <faceType=...> 或 [图片] 占位，喂给模型前都清掉
  return text
    .replace(/<@!?[^>]*>/g, " ")
    .replace(/<faceType=[^>]*>/g, "")
    .replace(/\[(图片|表情|语音|视频|文件|动画表情|闪照)\]/g, "")
    .replace(/[\u200b-\u200f\ufeff]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * 事件分发 + 会话编排：去重、按会话串行、调用大模型、发送回复。
 */
/**
 * 判断一条群消息是否 @ 了机器人。
 * 开了「接收全量消息」后，@ 消息也走 GROUP_MESSAGE_CREATE，
 * 只能靠 mentions（bot=true）或正文里的 <@openid> 判断。
 */
export function isBotMentioned(d, botOpenid) {
  if (Array.isArray(d?.mentions) && d.mentions.some((mention) => mention?.bot === true)) return true;
  if (botOpenid && typeof d?.content === "string" && d.content.includes(`<@${botOpenid}>`)) return true;
  return false;
}

export class Bot {
  #queue = new Map();
  #seen = new Map();
  #lastAmbientReply = new Map();
  #personaCooldown = new Map();
  #startedAt = Date.now();
  #stopped = false;
  #botOpenid = null;

  constructor({ config, api, gateway, llm, memory, responder, search, weather, news, persona, logger }) {
    this.config = config;
    this.api = api;
    this.gateway = gateway;
    this.llm = llm;
    this.memory = memory;
    this.responder = responder;
    this.search = search;
    this.weather = weather;
    this.news = news;
    this.persona = persona;
    this.logger = logger;
  }

  async start() {
    this.gateway.on("ready", (data) => {
      const name = data?.user?.username ?? this.config.botName;
      this.#botOpenid = data?.user?.id ?? null;
      this.logger.info(`机器人已上线：${name}（id=${this.#botOpenid ?? "未知"}）；等待群 @ 或私聊消息…`);
    });

    this.gateway.on("resumed", () => {
      this.logger.info("连接恢复，继续接收消息");
    });

    this.gateway.on("event", (event) => this.#onGatewayEvent(event));

    this.gateway.on("fatal", (error) => {
      this.logger.error(`网关致命错误：${error.message}`);
      this.#stopped = true;
    });

    await this.gateway.start();
  }

  async stop() {
    this.#stopped = true;
    await this.gateway.stop();
    await this.memory.close();
    await this.persona?.close();
  }

  #onGatewayEvent({ t, d }) {
    if (!d) return;
    switch (t) {
      case "GROUP_AT_MESSAGE_CREATE": {
        const key = `group:${d.group_openid}:${d.author?.member_openid ?? d.author?.id}`;
        this.#enqueue(key, () => this.#handleGroupMessage(d));
        break;
      }
      case "GROUP_MESSAGE_CREATE": {
        // 群主开启「接收所有消息」后，全量消息走这个事件
        const key = `group:${d.group_openid}:${d.author?.member_openid ?? d.author?.id}`;
        this.#enqueue(key, () => this.#handleGroupMessage(d, { ambient: true }));
        break;
      }
      case "C2C_MESSAGE_CREATE": {
        const key = `c2c:${d.author?.user_openid ?? d.author?.id}`;
        this.#enqueue(key, () => this.#handleC2CMessage(d));
        break;
      }
      case "GROUP_ADD_ROBOT": {
        this.logger.info(`机器人被添加到群：${d.group_openid}（操作者 ${d.op_member_openid ?? "未知"}）`);
        this.#greetGroup(d);
        break;
      }
      case "GROUP_DEL_ROBOT": {
        this.logger.info(`机器人被移出群：${d.group_openid}`);
        break;
      }
      case "FRIEND_ADD": {
        this.logger.info(`新用户添加机器人：${d.openid ?? d.user_openid ?? "未知"}`);
        break;
      }
      case "FRIEND_DEL": {
        this.logger.info(`用户删除机器人：${d.openid ?? d.user_openid ?? "未知"}`);
        break;
      }
      default: {
        this.logger.debug(`忽略事件 ${t}`);
      }
    }
  }

  async #handleGroupMessage(d, { ambient = false } = {}) {
    const msgId = d.id;
    const groupOpenid = d.group_openid;
    const memberOpenid = d.author?.member_openid ?? d.author?.id ?? "unknown";
    const nickname = d.author?.username ?? "群友";

    if (this.#isDuplicate(msgId)) {
      this.logger.debug(`忽略重复推送的消息 ${String(msgId).slice(0, 16)}…`);
      return;
    }

    if (this.config.allowGroups.length && !this.config.allowGroups.includes(groupOpenid)) {
      this.logger.debug(`群 ${String(groupOpenid).slice(0, 8)}… 不在白名单，忽略`);
      return;
    }

    const text = extractText(d);
    if (!text) {
      if (!ambient && Array.isArray(d.attachments) && d.attachments.length) {
        await this.#safeReplyGroup(groupOpenid, msgId, "我暂时只能读文字消息，发句话给我吧～");
      }
      return;
    }

    const directMention = ambient ? this.#isBotMentioned(d) : false;

    // @ 了别人（或识别失败）时不接话，但把 mentions 打出来，方便排查识别问题
    if (ambient && !directMention && typeof d.content === "string" && d.content.includes("<@")) {
      this.logger.info(`含@的全量消息未识别为@机器人：mentions=${JSON.stringify((d.mentions ?? []).map((m) => ({ id: m?.id, bot: m?.bot })))}`);
    }

    if (ambient && !this.#shouldReplyAmbient(d, text, directMention)) {
      this.logger.debug(`全量消息未命中接话规则（policy=${this.config.group.messagePolicy}）：${text.slice(0, 40)}`);
      return;
    }

    if (text.length > MAX_INPUT_CHARS) {
      this.logger.warn(`群消息过长（${text.length} 字），已截断`);
    }
    const input = text.slice(0, MAX_INPUT_CHARS);

    if (ambient) {
      // 被 @ 或被引用一律接；问句也接；其余闲聊受冷却限制，避免刷屏
      const isQuestion = /[?？]/.test(text);
      const last = this.#lastAmbientReply.get(groupOpenid) ?? 0;
      const waitMs = this.config.group.cooldownMs - (Date.now() - last);
      if (!directMention && !isQuestion && waitMs > 0) {
        this.logger.info(`全量模式冷却中（还需 ${Math.ceil(waitMs / 1000)}s），跳过：${input.slice(0, 30)}`);
        return;
      }
      this.#lastAmbientReply.set(groupOpenid, Date.now());
      this.logger.info(
        `群 ${String(groupOpenid).slice(0, 8)}… | ${nickname}（${directMention ? "@机器人" : "未@，全量模式接话"}）: ${input.slice(0, 60)}`,
      );
    } else {
      this.logger.info(`群 ${String(groupOpenid).slice(0, 8)}… | ${nickname}: ${input.slice(0, 80)}`);
    }

    const scopeKey = groupOpenid;
    const command = parseCommand(input);
    if (command) {
      await this.#handleCommand(command, {
        conversationKey: `group:${groupOpenid}:${memberOpenid}`,
        scopeKey,
        groupOpenid,
        memberRole: d.author?.member_role,
        nickname,
        reply: (replyText) => this.#safeReplyGroup(groupOpenid, msgId, replyText),
      });
      return;
    }

    // “以后说话结尾加喵～”这类要求：记下来，立即生效
    if (this.config.persona.enabled && looksLikePersonaInstruction(input)) {
      const handled = await this.#applyPersonaRule(groupOpenid, input, nickname, (replyText) =>
        this.#safeReplyGroup(groupOpenid, msgId, replyText),
      );
      if (handled) return;
    }

    await this.#converse({
      conversationKey: `group:${groupOpenid}:${memberOpenid}`,
      scopeKey,
      input,
      reply: (replyText) => this.#safeReplyGroup(groupOpenid, msgId, replyText),
    });
  }

  async #handleC2CMessage(d) {
    const msgId = d.id;
    const userOpenid = d.author?.user_openid ?? d.author?.id;
    const nickname = d.author?.username ?? "用户";

    if (this.#isDuplicate(msgId)) return;

    const text = extractText(d);
    if (!text) {
      if (Array.isArray(d.attachments) && d.attachments.length) {
        await this.#safeReplyC2C(userOpenid, msgId, "我暂时只能读文字消息，发句话给我吧～");
      }
      return;
    }

    const input = text.slice(0, MAX_INPUT_CHARS);
    this.logger.info(`私聊 | ${nickname}: ${input.slice(0, 80)}`);

    const command = parseCommand(input);
    if (command) {
      await this.#handleCommand(command, {
        conversationKey: `c2c:${userOpenid}`,
        scopeKey: `c2c:${userOpenid}`,
        nickname,
        reply: (replyText) => this.#safeReplyC2C(userOpenid, msgId, replyText),
      });
      return;
    }

    await this.#converse({
      conversationKey: `c2c:${userOpenid}`,
      scopeKey: `c2c:${userOpenid}`,
      input,
      reply: (replyText) => this.#safeReplyC2C(userOpenid, msgId, replyText),
    });
  }

  async #handleCommand(command, { conversationKey, scopeKey, groupOpenid, memberRole, nickname, reply }) {
    if (command.name === "help") {
      await reply(helpText(this.config.botName));
      return;
    }
    if (command.name === "ping") {
      await reply(pingText(this.#startedAt));
      return;
    }
    if (command.name === "search") {
      await this.#handleSearch(command.args, { conversationKey, scopeKey, reply });
      return;
    }
    if (command.name === "persona") {
      await this.#handlePersonaCommand(command.args, { groupOpenid, memberRole, nickname, reply });
      return;
    }
    if (command.name === "clear") {
      const existed = this.memory.clear(conversationKey);
      this.logger.info(`清空会话记忆：${conversationKey}（${existed ? "有历史" : "无历史"}）`);
      await reply(existed ? "已清空我们这段对话的记忆，重新开始吧～" : "我们还没聊过几句，直接说吧～");
    }
  }

  /** /人设 命令：查看、添加、重置本群的人设规则。 */
  async #handlePersonaCommand(arg, { groupOpenid, memberRole, nickname, reply }) {
    if (!this.config.persona.enabled) {
      await reply("群内修改人设的功能已关闭（PERSONA_ENABLED=0）。");
      return;
    }
    if (!groupOpenid) {
      await reply("人设规则只对群聊生效。");
      return;
    }

    if (!arg) {
      const rules = this.persona.getRules(groupOpenid);
      if (!rules.length) {
        await reply("本群还没有额外人设规则。直接说「以后说话结尾加喵～」我就记住。");
        return;
      }
      const lines = rules.map((rule, index) => `${index + 1}. ${rule.text}`);
      await reply(`本群人设规则：\n${lines.join("\n")}\n\n群主/管理员可发「/人设 reset」清空。`);
      return;
    }

    if (/^(reset|清空|重置)$/i.test(arg)) {
      if (!["owner", "admin"].includes(String(memberRole ?? ""))) {
        await reply("只有群主或管理员能清空人设规则。");
        return;
      }
      const existed = this.persona.reset(groupOpenid);
      await reply(existed ? "已清空本群的人设规则，恢复正常语气。" : "本群本来就没有人设规则。");
      return;
    }

    const result = this.persona.addRule(groupOpenid, arg, nickname);
    if (!result.ok) {
      await reply("这条规则是空的，换个说法？");
      return;
    }
    await reply(`好，记住了：${arg}\n（我会从下一句开始照做；发「/人设」可查看全部规则）`);
  }

  /** 群友自然语言提的人设要求，例如“以后每句话结尾加个喵～”。 */
  async #applyPersonaRule(groupOpenid, text, nickname, reply) {
    const now = Date.now();
    const last = this.#personaCooldown.get(groupOpenid) ?? 0;
    const waitMs = this.config.persona.cooldownMs - (now - last);
    if (waitMs > 0) {
      this.logger.info(`人设修改冷却中（还需 ${Math.ceil(waitMs / 1000)}s），忽略：${text.slice(0, 30)}`);
      await reply("刚改过，等一会儿再改吧～");
      return true;
    }

    const result = this.persona.addRule(groupOpenid, text, nickname);
    if (!result.ok) return false;
    this.#personaCooldown.set(groupOpenid, now);
    await reply(`好，记住了：${text}\n（从下一句开始生效；发「/人设」可查看全部规则）`);
    return true;
  }

  /** 强制联网搜索后再回答（/search 命令）。 */
  async #handleSearch(query, { conversationKey, scopeKey, reply }) {
    if (!this.search?.enabled) {
      await reply("联网搜索还没开启，需要先在 .env 里配置 SEARCH_PROVIDER。");
      return;
    }
    if (!query) {
      await reply("用法：/search 关键词，比如 /search 今天北京天气");
      return;
    }

    let results;
    try {
      results = await this.search.search(query);
    } catch (error) {
      this.logger.warn(`搜索失败：${error.message}`);
      await reply("搜索服务暂时连不上，我先按自己的知识回答，可能不是最新的。");
      return;
    }

    if (!results.length) {
      await reply(`没搜到「${query}」的相关结果，换个说法试试？`);
      return;
    }

    const messages = [
      { role: "system", content: this.#systemPrompt(scopeKey) },
      {
        role: "user",
        content: `请根据下面的搜索结果回答问题。\n\n问题：${query}\n\n搜索结果：\n${formatSearchResults(results)}`,
      },
    ];

    let answer;
    try {
      answer = await this.llm.chat(messages);
    } catch (error) {
      this.logger.error(`搜索后生成回答失败：${error.message}`);
      await reply("搜到了资料，但组织答案时出错了，稍后再试～");
      return;
    }

    this.memory.append(conversationKey, `/search ${query}`, answer);
    await reply(answer);
  }

  /** 当前可用的工具列表（搜索/天气各自可独立开关）。 */
  #toolList() {
    const tools = [];
    if (this.search?.enabled) tools.push(SEARCH_TOOL);
    if (this.weather?.enabled) tools.push(WEATHER_TOOL);
    if (this.news?.enabled) tools.push(NEWS_TOOL);
    return tools;
  }

  #systemPrompt(scopeKey) {
    const hints = [];
    if (this.search?.enabled) hints.push(SEARCH_SYSTEM_HINT);
    if (this.weather?.enabled) hints.push(WEATHER_SYSTEM_HINT);
    if (this.news?.enabled) hints.push(NEWS_SYSTEM_HINT);

    let prompt = this.config.llm.systemPrompt;
    const rules = scopeKey ? (this.persona?.getRules(scopeKey) ?? []) : [];
    if (rules.length) {
      prompt +=
        "\n\n本群群友对说话方式的额外要求（按时间先后，越靠后优先级越高，冲突时以后者为准）：\n" +
        rules.map((rule, index) => `${index + 1}. ${rule.text}`).join("\n");
    }

    return hints.length ? `${prompt}\n\n${hints.join("\n")}` : prompt;
  }

  /** 把模型发起的工具调用落到真实能力上。 */
  async #runTool(name, args) {
    if (name === "web_search") {
      const query = String(args?.query ?? "").trim();
      if (!query) return "搜索关键词为空，请换一个更具体的说法。";
      const results = await this.search.search(query);
      if (!results.length) return "没有搜到相关结果。";
      return formatSearchResults(results);
    }
    if (name === "get_weather") {
      const city = String(args?.city ?? "").trim();
      if (!city) return "缺少城市名，请先问用户是哪个城市。";
      return this.weather.describe(city);
    }
    if (name === "get_tech_news") {
      const keyword = String(args?.keyword ?? "").trim();
      const items = await this.news.latest({ keyword });
      if (!items.length) return "暂时没取到新闻。";
      return formatNews(items);
    }
    return `未知工具：${name}`;
  }

  async #converse({ conversationKey, scopeKey, input, reply }) {
    const history = this.memory.get(conversationKey);
    const tools = this.#toolList();
    const messages = [
      { role: "system", content: this.#systemPrompt(scopeKey) },
      ...history,
      { role: "user", content: input },
    ];

    const startedAt = Date.now();
    let answer;
    try {
      answer = tools.length
        ? await this.llm.chatWithTools({
            messages,
            tools,
            onToolCall: (name, args) => this.#runTool(name, args),
          })
        : await this.llm.chat(messages);
    } catch (error) {
      this.logger.error(`生成回复失败（${Date.now() - startedAt}ms）：${error.message}`);
      await reply("抱歉，我这边一时没想出来，稍后再试一次吧～");
      return;
    }

    this.logger.info(`回复生成完成，用时 ${Date.now() - startedAt}ms，${answer.length} 字`);
    this.memory.append(conversationKey, input, answer);
    await reply(answer);
  }

  async #safeReplyGroup(groupOpenid, msgId, text) {
    try {
      await this.responder.replyGroup(groupOpenid, msgId, text);
    } catch (error) {
      this.logger.error(`回复群消息失败：${error.message}`);
    }
  }

  async #safeReplyC2C(userOpenid, msgId, text) {
    try {
      await this.responder.replyC2C(userOpenid, msgId, text);
    } catch (error) {
      this.logger.error(`回复私聊消息失败：${error.message}`);
    }
  }

  async #greetGroup(d) {
    if (this.#stopped) return;
    const eventId = d?.event_id ?? d?.id;
    if (!eventId || !d?.group_openid) return;
    try {
      await this.api.sendGroupMessage(d.group_openid, {
        content: `大家好，我是${this.config.botName}～ 在群里 @我 就能聊天啦，输入 /help 查看玩法。`,
        msg_type: 0,
        event_id: eventId,
      });
      this.logger.info(`已在群 ${String(d.group_openid).slice(0, 8)}… 发送入群欢迎语`);
    } catch (error) {
      this.logger.warn(`入群欢迎语发送失败：${error.message}`);
    }
  }

  /** 全量事件里判断这条消息有没有 @ 机器人（@ 会被替换成 <@openid>，见 mentions）。 */
  #isBotMentioned(d) {
    return isBotMentioned(d, this.#botOpenid);
  }

  /** 全量模式下判断一条普通消息是否值得接话。 */
  #shouldReplyAmbient(d, text, directMention = false) {
    const policy = this.config.group.messagePolicy;
    if (d.author?.bot) return false;
    if (policy === "off") return directMention;
    if (policy === "all") return true;
    if (directMention) return true;
    if (this.config.botName && text.includes(this.config.botName)) return true;
    if (parseCommand(text)) return true;
    return false;
  }

  #isDuplicate(msgId) {
    if (!msgId) return false;
    const now = Date.now();
    if (this.#seen.size > 500) {
      for (const [id, at] of this.#seen) {
        if (now - at > 10 * 60 * 1000) this.#seen.delete(id);
      }
    }
    if (this.#seen.has(msgId)) return true;
    this.#seen.set(msgId, now);
    return false;
  }

  /** 同一会话的任务串行执行，保证上下文顺序。 */
  #enqueue(key, task) {
    const previous = this.#queue.get(key) ?? Promise.resolve();
    const next = previous
      .then(task)
      .catch((error) => {
        this.logger.error(`处理消息异常：${error.stack || error.message}`);
      })
      .finally(() => {
        if (this.#queue.get(key) === next) this.#queue.delete(key);
      });
    this.#queue.set(key, next);
  }
}
