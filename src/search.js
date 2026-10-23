import { decodeEntities, formatDate, parseRssItems, stripHtml } from "./rss.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * 生成检索用的关键词变体：原句 → 去掉疑问词 → 去掉大写缩写。
 * 必应中文区对「是谁」「IEM」这类成分很敏感，换个说法结果可能完全不同。
 */
export function buildQueryVariants(keyword) {
  const stripQuestion = (text) =>
    text
      .replace(/^请问[，,：:\s]*/, "")
      .replace(/[（(]?\s*[?？]\s*[）)]?$/, "")
      .replace(/(是谁|是什么|是多少|多少钱|怎么样|怎么回事|怎么办|为什么|怎么|吗|呢|呀|啊)$/, "")
      .trim();
  const stripAbbrev = (text) =>
    text
      .split(/\s+/)
      .filter((token) => !/^[A-Z]{2,5}\d*$/.test(token))
      .join(" ")
      .trim();

  const variants = [];
  for (const candidate of [
    keyword,
    stripQuestion(keyword),
    stripAbbrev(keyword),
    stripAbbrev(stripQuestion(keyword)),
  ]) {
    const value = candidate.trim();
    if (value && !variants.includes(value)) variants.push(value);
  }
  return variants.slice(0, 3);
}

/** 把查询切成可比较的关键词（英文词、数字、成段中文）。 */
export function tokenize(query) {
  return (String(query ?? "").toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fa5]{2,}/g) ?? []).filter(
    (token) => token.length >= 2,
  );
}

/**
 * 结果相关性：查询关键词在「标题+摘要」里命中的比例。
 * 用来识别「必应返回了一堆无关结果」的情况（例如中文区搜 IEM 会给放假安排）。
 */
export function relevanceScore(results, query) {
  const tokens = tokenize(query);
  if (!tokens.length || !results.length) return 0;
  const text = results.map((item) => `${item.title} ${item.snippet}`).join(" ").toLowerCase();
  const hit = tokens.filter((token) => text.includes(token)).length;
  return hit / tokens.length;
}

export class SearchError extends Error {
  constructor(message) {
    super(message);
    this.name = "SearchError";
  }
}

/**
 * 联网搜索。默认走 Bing 的 RSS 输出（免密钥、国内可直连、结果是结构化 XML）；
 * 配置 TAVILY_API_KEY 后可切换为 Tavily（摘要质量更好）。
 */
export class SearchClient {
  constructor({ config, logger }) {
    this.cfg = config.search;
    this.logger = logger;
    this.provider = this.#resolveProvider();
    if (this.provider === "off") {
      this.logger.info("联网搜索未启用");
    } else {
      this.logger.info(`联网搜索已启用（provider=${this.provider}）`);
    }
  }

  #resolveProvider() {
    const configured = this.cfg.provider;
    if (configured === "off") return "off";
    if (configured === "tavily") return this.cfg.tavilyApiKey ? "tavily" : "bing";
    if (configured === "bing") return "bing";
    return this.cfg.tavilyApiKey ? "tavily" : "bing";
  }

  get enabled() {
    return this.provider !== "off";
  }

  /**
   * 启动预热：Tavily 在冷启动时要付 6~7 秒的 DNS/TLS 握手成本，
   * 启动时先建连，用户第一次搜索就不会卡。HEAD 请求不消耗额度。
   */
  async warmup() {
    if (this.provider !== "tavily") return;
    const startedAt = Date.now();
    try {
      const origin = new URL(this.cfg.tavilyEndpoint).origin + "/";
      await fetch(origin, { method: "HEAD", signal: AbortSignal.timeout(this.cfg.timeoutMs) });
      this.logger.info(`Tavily 连接预热完成（${Date.now() - startedAt}ms）`);
    } catch (error) {
      this.logger.debug(`Tavily 预热失败（不影响使用）：${error.message}`);
    }
  }

  /**
   * @param {string} query
   * @returns {Promise<{title: string, url: string, snippet: string, date: string}[]>}
   */
  async search(query) {
    const keyword = String(query ?? "").trim().slice(0, 200);
    if (!keyword) throw new SearchError("搜索关键词为空");

    if (this.provider === "tavily") {
      try {
        return await this.#tavily(keyword);
      } catch (error) {
        // Key 失效/额度用尽/接口异常时自动退回必应，保证机器人不会因此失能
        this.logger.warn(`Tavily 检索失败（${error.message}），回退到必应`);
        return this.#bing(keyword);
      }
    }
    return this.#bing(keyword);
  }

  async #bing(keyword) {
    const recent =
      this.cfg.recencyFilter &&
      /(最新|新闻|今天|今日|最近|刚刚|发布|上市|开售|价格|股价|汇率|比分|赛程|天气|版本|更新|新品|冠军|决赛|比赛)/.test(
        keyword,
      );

    // 必应中文区对「是谁」「IEM」这类成分很敏感，相关性不足时换说法再搜
    const variants = buildQueryVariants(keyword);

    let best = [];
    let bestScore = -1;

    for (const [index, variant] of variants.entries()) {
      let results = [];
      try {
        results = await this.#bingHtml(variant, recent);
      } catch (error) {
        this.logger.warn(`必应网页检索失败（${error.message}），回退 RSS`);
      }
      if (!results.length) results = await this.#bingRss(variant, recent);
      if (!results.length) continue;

      const score = relevanceScore(results, keyword);
      if (score > bestScore) {
        best = results;
        bestScore = score;
      }
      if (score >= 0.5) break;
      if (index < variants.length - 1) {
        this.logger.info(
          `「${variant}」结果相关性偏低（${score.toFixed(2)}），改用「${variants[index + 1]}」重试`,
        );
      }
    }

    return best;
  }

  /**
   * 抓必应网页结果（<li class="b_algo">）。质量明显好于 RSS 通道，
   * 唯一的代价是结果里没有发布时间，靠「近 7 天」过滤兜底。
   */
  async #bingHtml(keyword, recent) {
    const url =
      `${this.cfg.bingEndpoint}?q=${encodeURIComponent(keyword)}&setlang=zh-CN&mkt=zh-CN` +
      (recent ? "&qft=+filterui%3Aage-lt10080" : "");
    const startedAt = Date.now();
    let response;
    try {
      response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, "Accept-Language": "zh-CN,zh;q=0.9" },
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
        redirect: "follow",
      });
    } catch (error) {
      throw new SearchError(`搜索请求失败：${error.message}`);
    }
    if (!response.ok) throw new SearchError(`搜索接口返回 HTTP ${response.status}`);

    const html = await response.text();
    const blocks = [...html.matchAll(/<li class="b_algo"[\s\S]*?<\/li>/g)].map((match) => match[0]);
    const results = blocks
      .map((block) => {
        const titleHtml = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? "";
        const link = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"/)?.[1] ?? "";
        const snippetHtml =
          block.match(/<p class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/)?.[1] ??
          block.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ??
          "";
        const dateHtml = block.match(/<span class="news_dt">([\s\S]*?)<\/span>/)?.[1] ?? "";
        return {
          title: stripHtml(titleHtml),
          url: decodeEntities(link),
          snippet: stripHtml(snippetHtml).slice(0, 240),
          date: formatDate(stripHtml(dateHtml)),
        };
      })
      .filter((item) => item.title && (item.snippet || item.url))
      .slice(0, this.cfg.maxResults);

    this.logger.info(
      `Bing 网页「${keyword}」${recent ? "(近7天)" : ""}得到 ${results.length} 条（${Date.now() - startedAt}ms）`,
    );
    return results;
  }

  async #bingRss(keyword, recent) {
    const url =
      `${this.cfg.bingEndpoint}?q=${encodeURIComponent(keyword)}&format=rss&setlang=zh-CN` +
      (recent ? "&qft=+filterui%3Aage-lt10080" : "");
    const startedAt = Date.now();
    let response;
    try {
      response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, "Accept-Language": "zh-CN,zh;q=0.9" },
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
        redirect: "follow",
      });
    } catch (error) {
      throw new SearchError(`搜索请求失败：${error.message}`);
    }
    if (!response.ok) throw new SearchError(`搜索接口返回 HTTP ${response.status}`);

    const xml = await response.text();
    const results = parseRssItems(xml, 40)
      .filter((item) => item.snippet || item.url)
      .slice(0, this.cfg.maxResults);

    this.logger.info(
      `Bing RSS「${keyword}」${recent ? "(近7天)" : ""}得到 ${results.length} 条（${Date.now() - startedAt}ms）`,
    );
    return results;
  }

  async #tavily(keyword) {
    const startedAt = Date.now();
    let response;
    try {
      response = await fetch(this.cfg.tavilyEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.cfg.tavilyApiKey}`,
        },
        body: JSON.stringify({
          api_key: this.cfg.tavilyApiKey,
          query: keyword,
          max_results: this.cfg.maxResults,
          search_depth: "basic",
          include_answer: false,
          include_raw_content: false,
        }),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (error) {
      throw new SearchError(`Tavily 请求失败：${error.message}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new SearchError("Tavily API Key 无效或已失效");
    }
    if (response.status === 429) {
      throw new SearchError("Tavily 额度用尽或触发限流");
    }
    if (!response.ok) throw new SearchError(`Tavily 返回 HTTP ${response.status}`);

    const data = await response.json().catch(() => null);
    const results = (data?.results ?? [])
      .map((item) => ({
        title: String(item.title ?? "").trim(),
        url: String(item.url ?? "").trim(),
        snippet: String(item.content ?? "").replace(/\s+/g, " ").trim().slice(0, 240),
        date: formatDate(item.published_date),
      }))
      .filter((item) => item.title)
      .slice(0, this.cfg.maxResults);

    if (!results.length) throw new SearchError("Tavily 没有返回结果");

    this.logger.info(`Tavily 搜索「${keyword}」得到 ${results.length} 条（${Date.now() - startedAt}ms）`);
    return results;
  }
}

/** 给大模型看的搜索结果文本（不给 URL，避免回复里带链接被平台拦截）。 */
export function formatSearchResults(results) {
  return results
    .map((item, index) => {
      const host = hostOf(item.url);
      const lines = [`[${index + 1}] ${item.title}`, `摘要：${item.snippet || "（无摘要）"}`];
      if (item.date) lines.push(`时间：${item.date}`);
      if (host) lines.push(`来源：${host}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

export const SEARCH_TOOL = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "搜索互联网获取实时信息。当问题涉及新闻、天气、价格、汇率、赛事、股价、新版本、人物近况等时效性内容，" +
      "或你不确定的事实时，先调用它；日常闲聊、常识、写作、代码问题不要调用。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词，尽量具体，例如「北京 今天 天气」" },
      },
      required: ["query"],
    },
  },
};

export const SEARCH_SYSTEM_HINT =
  "你可以调用 web_search 获取实时信息，但只在确实需要最新信息时才调用（新闻、天气、价格、赛事、版本等）。" +
  "搜索结果可能过时或有误，请结合它给出结论；资料不足就直说不知道。" +
  "回复里不要出现网址链接，也不要写「根据搜索结果」这类话，直接给结论。";
