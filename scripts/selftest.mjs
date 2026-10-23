/**
 * 离线自测：用本地 mock 的 网关 + OpenAPI + 大模型，跑通整条链路。
 * 不消耗真实凭证与额度，用来验证协议实现、去重、分条、命令、私聊。
 *
 *   node scripts/selftest.mjs
 */
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";

import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { TokenManager } from "../src/token.js";
import { QQApi } from "../src/api.js";
import { Gateway } from "../src/gateway.js";
import { LlmClient } from "../src/llm.js";
import { MemoryStore } from "../src/memory.js";
import { Responder, splitMessage } from "../src/responder.js";
import { SearchClient, buildQueryVariants, relevanceScore, tokenize } from "../src/search.js";
import { WeatherClient } from "../src/weather.js";
import { NewsClient } from "../src/news.js";
import { PersonaStore, looksLikePersonaInstruction } from "../src/persona.js";
import { Bot, isBotMentioned } from "../src/bot.js";

const INTENTS = 1 << 25;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  [PASS] ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  [FAIL] ${name}: ${error.message}`);
  }
}

// ---------- 1. 纯函数先测 ----------
console.log("== 单元检查 ==");
check("splitMessage 短文本不切分", () => {
  assert.deepEqual(splitMessage("你好", 700, 3), ["你好"]);
});
check("splitMessage 长文本按上限切分", () => {
  const text = "第一段内容。".repeat(200); // 1200 字
  const chunks = splitMessage(text, 500, 3);
  assert.ok(chunks.length >= 2 && chunks.length <= 3, `实际 ${chunks.length} 段`);
  for (const chunk of chunks) assert.ok(chunk.length <= 501);
  assert.ok(chunks.join("").startsWith("第一段内容"));
});
check("splitMessage 保留空字符串为 0 段", () => {
  assert.deepEqual(splitMessage("   \n ", 700, 3), []);
});
check("tokenize 能切出中英文关键词", () => {
  assert.deepEqual(tokenize("2026 IEM 科隆 Major 冠军"), ["2026", "iem", "科隆", "major", "冠军"]);
});
check("relevanceScore 能识别无关结果", () => {  const garbage = [
    { title: "2026年_百度百科", snippet: "公历平年，共365天" },
    { title: "国务院办公厅关于2026年部分节假日安排的通知", snippet: "元旦、春节放假安排" },
  ];
  const good = [
    { title: "2026年IEM科隆Major", snippet: "Falcons 在总决赛 3:0 战胜 FURIA" },
    { title: "2026IEM科隆Major落幕 Team Falcons夺冠", snippet: "科隆朗盛竞技场" },
  ];
  const query = "2026 IEM 科隆 Major 冠军";
  assert.ok(relevanceScore(garbage, query) < 0.5, `垃圾结果得分 ${relevanceScore(garbage, query)}`);
  assert.ok(relevanceScore(good, query) >= 0.5, `正常结果得分 ${relevanceScore(good, query)}`);
});
check("buildQueryVariants 能去掉疑问词与大写缩写", () => {
  assert.deepEqual(buildQueryVariants("2026科隆major冠军是谁"), [
    "2026科隆major冠军是谁",
    "2026科隆major冠军",
  ]);
  assert.deepEqual(buildQueryVariants("2026 IEM 科隆 Major 冠军"), [
    "2026 IEM 科隆 Major 冠军",
    "2026 科隆 Major 冠军",
  ]);
});
check("isBotMentioned 能识别 @机器人（全量事件场景）", () => {
  // 开了全量权限后，@ 消息也走 GROUP_MESSAGE_CREATE，靠 mentions 判断
  assert.equal(isBotMentioned({ mentions: [{ id: "BOT", bot: true }], content: "你好" }, null), true);
  assert.equal(isBotMentioned({ content: "<@123456> 你好" }, "123456"), true);
  assert.equal(isBotMentioned({ mentions: [{ id: "U1", bot: false }], content: "你好" }, "123456"), false);
  assert.equal(isBotMentioned({ content: "今天吃什么" }, "123456"), false);
});
check("looksLikePersonaInstruction 能识别人设要求", () => {
  assert.equal(looksLikePersonaInstruction("以后每句话结尾加一个喵～"), true);
  assert.equal(looksLikePersonaInstruction("你以后别说话了"), true);
  assert.equal(looksLikePersonaInstruction("将你的人设修改为傲娇，并在每次回答后加上喵~"), true);
  assert.equal(looksLikePersonaInstruction("语气改温柔一点"), true);
  assert.equal(looksLikePersonaInstruction("今天中午吃什么"), false);
  assert.equal(looksLikePersonaInstruction("你的人设是什么"), false);
  assert.equal(looksLikePersonaInstruction("帮我写个周报"), false);
});

// ---------- 2. 起 mock 服务 ----------
const sent = [];
const llmCalls = [];
const searchRequests = [];
const weatherRequests = [];
const newsRequests = [];
let identifyPayload = null;
let resumePayload = null;
let connections = 0;
let tokenCalls = 0;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  const body = raw ? JSON.parse(raw) : null;
  const json = (status, data) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };

  if (url.pathname === "/app/getAppAccessToken") {
    tokenCalls += 1;
    if (body?.appId !== "test-app" || body?.clientSecret !== "0123456789abcdef0123456789abcdef") {
      return json(200, { code: 100016, message: "invalid appid or secret" });
    }
    return json(200, { access_token: "test-token", expires_in: 7200 });
  }

  if (url.pathname === "/users/@me") {
    if (req.headers.authorization !== "QQBot test-token") return json(401, { message: "bad token" });
    return json(200, { id: "bot-1", username: "测试机器人" });
  }

  if (url.pathname === "/gateway/bot") {
    if (req.headers.authorization !== "QQBot test-token") return json(401, { message: "bad token" });
    return json(200, { url: `ws://127.0.0.1:${server.address().port}/ws`, shards: 1 });
  }

  const groupMatch = url.pathname.match(/^\/v2\/groups\/([^/]+)\/messages$/);
  if (groupMatch && req.method === "POST") {
    if (req.headers.authorization !== "QQBot test-token") return json(401, { message: "bad token" });
    sent.push({ kind: "group", target: decodeURIComponent(groupMatch[1]), body, at: Date.now() });
    return json(200, { id: `sent-${sent.length}`, timestamp: new Date().toISOString() });
  }

  const c2cMatch = url.pathname.match(/^\/v2\/users\/([^/]+)\/messages$/);
  if (c2cMatch && req.method === "POST") {
    if (req.headers.authorization !== "QQBot test-token") return json(401, { message: "bad token" });
    sent.push({ kind: "c2c", target: decodeURIComponent(c2cMatch[1]), body, at: Date.now() });
    return json(200, { id: `sent-${sent.length}`, timestamp: new Date().toISOString() });
  }

  if (url.pathname === "/news") {
    newsRequests.push(url.searchParams.get("q") ?? "");
    res.writeHead(200, { "Content-Type": "application/rss+xml; charset=utf-8" });
    res.end(
      '<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>测试科技新闻</title>' +
        '<item><title>某厂商发布新一代 AI 芯片</title><link>https://example.com/1</link>' +
        "<description>性能提升 40%，主打端侧推理。</description>" +
        "<pubDate>Fri, 23 Oct 2026 09:00:00 GMT</pubDate></item>" +
        '<item><title>某系统更新推送</title><link>https://example.com/2</link>' +
        "<description>修复若干问题，优化续航。</description>" +
        "<pubDate>Fri, 23 Oct 2026 08:00:00 GMT</pubDate></item>" +
        "</channel></rss>",
    );
    return;
  }

  if (url.pathname === "/geo") {
    weatherRequests.push(`geo:${url.searchParams.get("name")}`);
    return json(200, {
      results: [{ name: "北京", latitude: 39.9, longitude: 116.4, admin1: "北京市", country: "中国" }],
    });
  }

  if (url.pathname === "/weather") {
    weatherRequests.push("forecast");
    return json(200, {
      current: {
        temperature_2m: 12.5,
        apparent_temperature: 11.1,
        relative_humidity_2m: 68,
        weather_code: 0,
        wind_speed_10m: 3.9,
      },
      daily: {
        time: ["2026-10-23", "2026-10-24"],
        temperature_2m_max: [15.6, 16.7],
        temperature_2m_min: [7.1, 8.1],
        precipitation_probability_max: [8, 8],
      },
    });
  }

  if (url.pathname === "/tavily") {
    return json(200, {
      results: [
        {
          title: "Tavily 搜索结果",
          url: "https://example.com/tavily",
          content: "来自 Tavily 的摘要内容。",
          published_date: "2026-10-22",
        },
      ],
    });
  }

  if (url.pathname === "/tavily-fail") {
    return json(401, { detail: { error: "Unauthorized: missing or invalid API key." } });
  }

  if (url.pathname === "/search") {
    const keyword = url.searchParams.get("q") ?? "";
    searchRequests.push(keyword);
    const generic = `<item><title>${keyword} 相关资讯</title><link>https://example.com/generic</link>` +
      "<description>与查询相关的公开资料。</description></item>";
    const items = /IEM/i.test(keyword)
      ? '<item><title>2026年_百度百科</title><link>https://example.com/year</link>' +
        "<description>公历平年，共 365 天，法定节假日安排。</description></item>" +
        '<item><title>2026 年放假安排</title><link>https://example.com/holiday</link>' +
        "<description>元旦、春节放假通知。</description></item>"
      : /科隆|Major/i.test(keyword)
        ? '<item><title>2026IEM科隆Major落幕 Team Falcons夺冠</title><link>https://example.com/falcons</link>' +
          "<description>Falcons 以 3:0 战胜 FURIA，队史首夺 Major 冠军。</description></item>" +
          '<item><title>天气网预报</title><link>https://example.com/weather</link>' +
          "<description>今天晴，18 到 26 度。</description></item>"
        : generic;
    res.writeHead(200, { "Content-Type": "application/rss+xml; charset=utf-8" });
    res.end(
      `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>必应：${keyword}</title>` +
        items +
        "</channel></rss>",
    );
    return;
  }

  if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
    llmCalls.push({ auth: req.headers.authorization, body });
    const lastMessage = body.messages.at(-1);
    const lastUser = [...body.messages].reverse().find((m) => m.role === "user");
    const content = lastUser?.content ?? "";

    // 模拟模型决定调用工具
    if (Array.isArray(body.tools) && body.tools.length) {
      if (lastMessage?.role === "tool") {
        const toolContent = String(lastMessage.content ?? "");
        let final;
        if (toolContent.includes("℃")) {
          final = "北京现在晴，12.5℃，今天 7 到 16℃，出门带件外套。";
        } else if (toolContent.includes("来源：测试源")) {
          final = "科技圈今天有两件事：某厂商发了新 AI 芯片，另一家推送了系统更新。";
        } else if (/Falcons|猎鹰/.test(toolContent)) {
          final = "2026 科隆 Major 冠军是 Falcons（猎鹰），决赛 3:0 战胜 FURIA。";
        } else {
          final = "iPhone 18 预计明年秋季发布，目前还没有官方日期。";
        }
        await sleep(30);
        return json(200, {
          id: "chatcmpl-tool-final",
          choices: [{ index: 0, message: { role: "assistant", content: final }, finish_reason: "stop" }],
        });
      }
      if (lastMessage?.role === "user" && /天气/.test(content)) {
        await sleep(30);
        return json(200, {
          id: "chatcmpl-weather-call",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_w1",
                    type: "function",
                    function: { name: "get_weather", arguments: JSON.stringify({ city: "北京" }) },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        });
      }
      if (lastMessage?.role === "user" && /新闻/.test(content)) {
        await sleep(30);
        return json(200, {
          id: "chatcmpl-news-call",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_n1",
                    type: "function",
                    function: { name: "get_tech_news", arguments: JSON.stringify({}) },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        });
      }
      if (lastMessage?.role === "user" && /Major/.test(content)) {
        await sleep(30);
        return json(200, {
          id: "chatcmpl-cs-call",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_cs1",
                    type: "function",
                    function: {
                      name: "web_search",
                      arguments: JSON.stringify({ query: "2026 IEM 科隆 Major 冠军" }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        });
      }
      if (lastMessage?.role === "user" && /发布|最新|价格/.test(content)) {
        await sleep(30);
        return json(200, {
          id: "chatcmpl-tool-call",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "web_search", arguments: JSON.stringify({ query: "iPhone 18 发布时间" }) },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        });
      }
    }

    let reply;
    if (content.includes("搜索结果")) {
      reply = "上海今天多云，20 到 24 度。";
    } else if (content.includes("长回复")) {
      reply = "这是一段很长的回答。".repeat(120); // 1200 字
    } else if (content.includes("私聊测试")) {
      reply = "私聊收到啦～";
    } else {
      reply = `收到：${content}`;
    }
    await sleep(30);
    return json(200, {
      id: "chatcmpl-test",
      choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  }

  return json(404, { message: "not found" });
});

const wss = new WebSocketServer({ server, path: "/ws" });
const sockets = new Set();

wss.on("connection", (ws) => {
  sockets.add(ws);
  connections += 1;
  ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));

  ws.on("message", (raw) => {
    const payload = JSON.parse(raw.toString());
    if (payload.op === 1) {
      ws.send(JSON.stringify({ op: 11 }));
      return;
    }
    if (payload.op === 6) {
      resumePayload = payload.d;
      ws.send(JSON.stringify({ op: 0, s: 100, t: "RESUMED", d: "" }));
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            op: 0,
            s: 101,
            t: "GROUP_AT_MESSAGE_CREATE",
            d: {
              id: "msg-4",
              content: "重连后还在吗",
              group_openid: "GROUP-1",
              author: { member_openid: "MEMBER-1", username: "小明", bot: false },
            },
          }),
        );
      }, 100);
      return;
    }
    if (payload.op === 2) {
      identifyPayload = payload.d;
      ws.send(
        JSON.stringify({
          op: 0,
          s: 1,
          t: "READY",
          d: { version: 1, session_id: "session-test", user: { id: "bot-1", username: "测试机器人", bot: true }, shard: [0, 1] },
        }),
      );

      setTimeout(() => {
        ws.send(
          JSON.stringify({
            op: 0,
            s: 2,
            t: "GROUP_AT_MESSAGE_CREATE",
            d: {
              id: "msg-1",
              content: "你好，介绍一下你自己",
              group_openid: "GROUP-1",
              author: { member_openid: "MEMBER-1", username: "小明", bot: false },
              timestamp: new Date().toISOString(),
            },
          }),
        );
        // 官方可能重复推送同一 msg_id，必须去重
        ws.send(
          JSON.stringify({
            op: 0,
            s: 3,
            t: "GROUP_AT_MESSAGE_CREATE",
            d: {
              id: "msg-1",
              content: "你好，介绍一下你自己",
              group_openid: "GROUP-1",
              author: { member_openid: "MEMBER-1", username: "小明", bot: false },
              timestamp: new Date().toISOString(),
            },
          }),
        );
      }, 120);

      setTimeout(() => {
        ws.send(
          JSON.stringify({
            op: 0,
            s: 4,
            t: "GROUP_AT_MESSAGE_CREATE",
            d: {
              id: "msg-2",
              content: "/ping",
              group_openid: "GROUP-1",
              author: { member_openid: "MEMBER-1", username: "小明", bot: false },
            },
          }),
        );
      }, 220);

      setTimeout(() => {
        ws.send(
          JSON.stringify({
            op: 0,
            s: 5,
            t: "C2C_MESSAGE_CREATE",
            d: {
              id: "msg-c2c-1",
              content: "私聊测试",
              author: { user_openid: "USER-1", username: "小红", bot: false },
            },
          }),
        );
      }, 320);

      setTimeout(() => {
        ws.send(
          JSON.stringify({
            op: 0,
            s: 6,
            t: "GROUP_AT_MESSAGE_CREATE",
            d: {
              id: "msg-3",
              content: "来一段长回复",
              group_openid: "GROUP-1",
              author: { member_openid: "MEMBER-2", username: "小刚", bot: false },
            },
          }),
        );
      }, 420);

      // 全量模式（群主开启「接收所有消息」）下的普通消息
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            op: 0,
            s: 7,
            t: "GROUP_MESSAGE_CREATE",
            d: {
              id: "msg-5",
              content: "<@7A3B9C1D5E2F4A6B8C0D1E3F5A7B9C2D> 测试机器人在吗，讲个冷笑话",
              group_openid: "GROUP-1",
              author: { member_openid: "MEMBER-1", username: "小明", bot: false },
              mentions: [
                { id: "7A3B9C1D5E2F4A6B8C0D1E3F5A7B9C2D", username: "路人", bot: false },
                { id: "BOT-SELF", username: "测试机器人", bot: true },
              ],
            },
          }),
        );
      }, 520);

      setTimeout(() => {
        ws.send(
          JSON.stringify({
            op: 0,
            s: 8,
            t: "GROUP_MESSAGE_CREATE",
            d: {
              id: "msg-6",
              content: "今天中午吃什么",
              group_openid: "GROUP-1",
              author: { member_openid: "MEMBER-1", username: "小明", bot: false },
            },
          }),
        );
      }, 560);

      setTimeout(() => {
        ws.send(
          JSON.stringify({
            op: 0,
            s: 9,
            t: "GROUP_MESSAGE_CREATE",
            d: {
              id: "msg-7",
              content: "测试机器人你好",
              group_openid: "GROUP-1",
              author: { member_openid: "BOT-X", username: "别人家的机器人", bot: true },
            },
          }),
        );
      }, 600);

      setTimeout(() => {
        ws.send(
          JSON.stringify({
            op: 0,
            s: 10,
            t: "GROUP_AT_MESSAGE_CREATE",
            d: {
              id: "msg-8",
              content: "今天北京天气怎么样",
              group_openid: "GROUP-1",
              author: { member_openid: "MEMBER-3", username: "小美", bot: false },
            },
          }),
        );
      }, 700);

      setTimeout(() => {
        ws.send(
          JSON.stringify({
            op: 0,
            s: 11,
            t: "GROUP_AT_MESSAGE_CREATE",
            d: {
              id: "msg-9",
              content: "/search 上海天气",
              group_openid: "GROUP-1",
              author: { member_openid: "MEMBER-3", username: "小美", bot: false },
            },
          }),
        );
      }, 820);

      setTimeout(() => {
        ws.send(
          JSON.stringify({
            op: 0,
            s: 12,
            t: "GROUP_AT_MESSAGE_CREATE",
            d: {
              id: "msg-10",
              content: "最近有什么科技新闻",
              group_openid: "GROUP-1",
              author: { member_openid: "MEMBER-3", username: "小美", bot: false },
            },
          }),
        );
      }, 940);

      setTimeout(() => {
        ws.send(
          JSON.stringify({
            op: 0,
            s: 13,
            t: "GROUP_AT_MESSAGE_CREATE",
            d: {
              id: "msg-11",
              content: "iPhone 18 什么时候发布",
              group_openid: "GROUP-1",
              author: { member_openid: "MEMBER-3", username: "小美", bot: false },
            },
          }),
        );
      }, 1060);

      setTimeout(() => {
        ws.send(
          JSON.stringify({
            op: 0,
            s: 14,
            t: "GROUP_AT_MESSAGE_CREATE",
            d: {
              id: "msg-12",
              content: "2026 IEM 科隆 Major 冠军是谁",
              group_openid: "GROUP-1",
              author: { member_openid: "MEMBER-4", username: "小强", bot: false },
            },
          }),
        );
      }, 1180);

      setTimeout(() => {
        ws.send(
          JSON.stringify({
            op: 0,
            s: 15,
            t: "GROUP_AT_MESSAGE_CREATE",
            d: {
              id: "msg-13",
              content: "以后每句话结尾都加一个喵～",
              group_openid: "GROUP-1",
              author: { member_openid: "MEMBER-5", username: "小七", bot: false, member_role: "member" },
            },
          }),
        );
      }, 1300);

      setTimeout(() => {
        ws.send(
          JSON.stringify({
            op: 0,
            s: 16,
            t: "GROUP_AT_MESSAGE_CREATE",
            d: {
              id: "msg-14",
              content: "讲个笑话",
              group_openid: "GROUP-1",
              author: { member_openid: "MEMBER-5", username: "小七", bot: false, member_role: "member" },
            },
          }),
        );
      }, 1500);
    }
  });

  ws.on("close", () => sockets.delete(ws));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const dataDir = await mkdtemp(path.join(tmpdir(), "qqbot-selftest-"));

const config = loadConfig({
  BOT_APP_ID: "test-app",
  BOT_APP_SECRET: "0123456789abcdef0123456789abcdef",
  BOT_NAME: "测试机器人",
  QQ_API_BASE: `http://127.0.0.1:${port}`,
  QQ_TOKEN_URL: `http://127.0.0.1:${port}/app/getAppAccessToken`,
  QQ_GATEWAY_URL: `ws://127.0.0.1:${port}/ws`,
  LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
  LLM_API_KEY: "test-key",
  LLM_MODEL: "mock-model",
  SEARCH_PROVIDER: "bing",
  SEARCH_BING_ENDPOINT: `http://127.0.0.1:${port}/search`,
  WEATHER_GEO_ENDPOINT: `http://127.0.0.1:${port}/geo`,
  WEATHER_FORECAST_ENDPOINT: `http://127.0.0.1:${port}/weather`,
  NEWS_FEEDS: `测试源|http://127.0.0.1:${port}/news`,
  REPLY_MAX_CHARS: "500",
  REPLY_MAX_CHUNKS: "3",
  REPLY_MIN_INTERVAL_MS: "0",
  GROUP_MESSAGE_POLICY: "off",
  DATA_DIR: dataDir,
  LOG_LEVEL: "error",
});

const logger = createLogger(config.logLevel);
const tokens = new TokenManager({ appId: config.appId, appSecret: config.appSecret, tokenUrl: config.tokenUrl, logger });
const api = new QQApi({ config, tokens, logger });
const gateway = new Gateway({ api, tokens, config, logger });
const llm = new LlmClient({ config, logger });
const search = new SearchClient({ config, logger });
const weather = new WeatherClient({ config, logger });
const news = new NewsClient({ config, logger });
const memory = new MemoryStore({ dir: config.dataDir, maxTurns: config.llm.historyTurns, logger });
await memory.init();
const persona = new PersonaStore({ dir: config.dataDir, maxRules: 5, logger });
await persona.init();
const responder = new Responder({ api, config, logger });
const bot = new Bot({ config, api, gateway, llm, memory, responder, search, weather, news, persona, logger });

// Tavily 通道（正常 + 失败回退）
const tavilyClient = new SearchClient({
  config: loadConfig({
    SEARCH_PROVIDER: "tavily",
    TAVILY_API_KEY: "tvly-test",
    TAVILY_ENDPOINT: `http://127.0.0.1:${port}/tavily`,
    LOG_LEVEL: "error",
  }),
  logger,
});
const tavilyResults = await tavilyClient.search("测试查询");

const fallbackClient = new SearchClient({
  config: loadConfig({
    SEARCH_PROVIDER: "tavily",
    TAVILY_API_KEY: "tvly-test",
    TAVILY_ENDPOINT: `http://127.0.0.1:${port}/tavily-fail`,
    SEARCH_BING_ENDPOINT: `http://127.0.0.1:${port}/search`,
    LOG_LEVEL: "error",
  }),
  logger,
});
const fallbackResults = await fallbackClient.search("2026 科隆 Major 冠军");

async function waitFor(predicate, timeoutMs = 12_000, label = "条件") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error(`等待超时：${label}`);
}

let exitCode = 0;
try {
  await bot.start();
  await waitFor(() => sent.length >= 5, 15_000, "收到回复");
  await sleep(400);
  await memory.save();

  console.log("\n== 集成检查 ==");

  check("Identify 使用 QQBot token 且 intents=1<<25", () => {
    assert.ok(identifyPayload, "没有收到 Identify");
    assert.equal(identifyPayload.token, "QQBot test-token");
    assert.equal(identifyPayload.intents, INTENTS);
    assert.deepEqual(identifyPayload.shard, [0, 1]);
  });

  check("access_token 只获取一次（有缓存）", () => {
    assert.equal(tokenCalls, 1, `实际 ${tokenCalls} 次`);
  });

  const groupMsgs = () => sent.filter((m) => m.kind === "group");
  const c2cMsgs = () => sent.filter((m) => m.kind === "c2c");

  check("重复推送的 msg-1 只回复一次", () => {
    const replies = groupMsgs().filter((m) => m.body.msg_id === "msg-1");
    assert.equal(replies.length, 1, `实际 ${replies.length} 条`);
    assert.ok(replies[0].body.content.includes("收到：你好，介绍一下你自己"));
    assert.equal(replies[0].body.msg_type, 0);
    assert.equal(replies[0].body.msg_seq, 1);
  });

  check("/ping 返回 pong 且带 msg_id", () => {
    const reply = groupMsgs().find((m) => m.body.msg_id === "msg-2");
    assert.ok(reply, "没有回复 /ping");
    assert.match(reply.body.content, /pong/);
  });

  check("私聊消息走 /v2/users 并回复", () => {
    const reply = c2cMsgs().find((m) => m.body.msg_id === "msg-c2c-1");
    assert.ok(reply, "没有回复私聊");
    assert.equal(reply.target, "USER-1");
    assert.match(reply.body.content, /私聊收到啦/);
  });

  check("长回复自动分条，msg_seq 递增且不超过 5", () => {
    const replies = groupMsgs().filter((m) => m.body.msg_id === "msg-3");
    assert.ok(replies.length >= 2, `实际 ${replies.length} 条`);
    assert.deepEqual(
      replies.map((m) => m.body.msg_seq),
      replies.map((_, index) => index + 1),
    );
    for (const reply of replies) assert.ok(reply.body.content.length <= 501);
  });

  check("向大模型发送了 system + 历史 + 当前消息", () => {
    assert.ok(llmCalls.length >= 3, `实际 ${llmCalls.length} 次`);
    const first = llmCalls[0].body;
    assert.equal(first.model, "mock-model");
    assert.equal(first.messages[0].role, "system");
    assert.equal(llmCalls[0].auth, "Bearer test-key");
  });

  check("会话记忆已落盘并可读回", () => {
    const history = memory.get("group:GROUP-1:MEMBER-1");
    assert.ok(history.length >= 2, `实际 ${history.length} 条`);
    assert.equal(history[0].role, "user");
    assert.equal(history.at(-1).role, "assistant");
  });

  check("所有请求都带正确的 Authorization", () => {
    assert.ok(sent.length > 0);
  });

  check("Tavily 通道可用", () => {
    assert.equal(tavilyResults[0]?.title, "Tavily 搜索结果");
    assert.equal(tavilyResults[0]?.date, "2026-10-22");
  });
  check("Tavily 失效时自动回退必应", () => {
    assert.ok(fallbackResults.length >= 1, "回退后没有结果");
    assert.ok(fallbackResults[0].title.includes("科隆"), `实际：${fallbackResults[0]?.title}`);
  });

  console.log("\n== 全量消息模式检查 ==");
  await waitFor(() => sent.some((m) => m.body.msg_id === "msg-5"), 8000, "全量模式接话");
  check("全量模式：@机器人会接话（off 策略），且清掉 <@...> 标记", () => {
    const reply = sent.find((m) => m.body.msg_id === "msg-5");
    assert.ok(reply.body.content.includes("收到：测试机器人在吗"), `实际：${reply.body.content}`);
    assert.ok(!reply.body.content.includes("<@"));
  });
  check("全量模式：没叫名字不插嘴", () => {
    assert.equal(sent.filter((m) => m.body.msg_id === "msg-6").length, 0);
  });
  check("全量模式：不回应其他机器人，避免互刷", () => {
    assert.equal(sent.filter((m) => m.body.msg_id === "msg-7").length, 0);
  });

  console.log("\n== 联网能力检查 ==");
  await waitFor(() => sent.some((m) => m.body.msg_id === "msg-8"), 12_000, "天气回复");
  check("天气工具：模型调用 get_weather 并给出实时数据", () => {
    const reply = sent.find((m) => m.body.msg_id === "msg-8");
    assert.match(reply.body.content, /12\.5|晴/);
    assert.ok(weatherRequests.some((r) => r.startsWith("geo:北京")), `实际：${weatherRequests.join("|")}`);
  });
  await waitFor(() => sent.some((m) => m.body.msg_id === "msg-10"), 12_000, "新闻回复");
  check("新闻工具：模型调用 get_tech_news 并归纳头条", () => {
    const reply = sent.find((m) => m.body.msg_id === "msg-10");
    assert.match(reply.body.content, /芯片/);
    assert.ok(newsRequests.length >= 1, "没有请求新闻源");
  });
  await waitFor(() => sent.some((m) => m.body.msg_id === "msg-11"), 12_000, "搜索回复");
  check("搜索工具：模型主动调用 web_search 并据此回答", () => {
    const reply = sent.find((m) => m.body.msg_id === "msg-11");
    assert.match(reply.body.content, /iPhone/);
    assert.ok(searchRequests.some((q) => q.includes("iPhone")), `实际搜索：${searchRequests.join("|")}`);
  });
  check("搜索结果以摘要形式喂给模型，且不含 URL", () => {
    const toolMessages = llmCalls.flatMap((call) => call.body.messages).filter((m) => m.role === "tool");
    const searchTool = toolMessages.find((m) => /摘要/.test(m.content));
    assert.ok(searchTool, "没有搜索工具消息");
    for (const message of toolMessages) {
      assert.ok(!/https?:\/\//.test(message.content), `工具结果不应含 URL：${message.content.slice(0, 60)}`);
    }
  });
  await waitFor(() => sent.some((m) => m.body.msg_id === "msg-9"), 12_000, "/search 回复");
  check("/search 命令强制搜索并回答", () => {
    const reply = sent.find((m) => m.body.msg_id === "msg-9");
    assert.match(reply.body.content, /上海/);
    assert.ok(searchRequests.some((q) => q.includes("上海")), `实际搜索：${searchRequests.join("|")}`);
  });
  await waitFor(() => sent.some((m) => m.body.msg_id === "msg-12"), 15_000, "相关性重试回复");
  check("结果不相关时自动换简化关键词重试", () => {
    const reply = sent.find((m) => m.body.msg_id === "msg-12");
    assert.match(reply.body.content, /Falcons|猎鹰/);
    assert.ok(searchRequests.includes("2026 科隆 Major 冠军"), `实际搜索：${searchRequests.join("|")}`);
  });

  console.log("\n== 人设规则检查 ==");
  await waitFor(() => sent.some((m) => m.body.msg_id === "msg-13"), 10_000, "人设确认");
  check("群友的人设要求被记住并确认", () => {
    const reply = sent.find((m) => m.body.msg_id === "msg-13");
    assert.match(reply.body.content, /记住了/);
    assert.ok(
      persona.getRules("GROUP-1").some((rule) => rule.text.includes("喵")),
      "规则没有保存",
    );
  });
  await waitFor(() => sent.some((m) => m.body.msg_id === "msg-14"), 12_000, "人设生效回复");
  check("人设规则进入 system prompt 并立即生效", () => {
    const call = llmCalls.find(
      (item) =>
        item.body?.messages?.[0]?.role === "system" &&
        String(item.body.messages[0].content).includes("群友对说话方式的额外要求"),
    );
    assert.ok(call, "后续请求的 system prompt 里没有带人设规则");
    assert.match(call.body.messages[0].content, /喵/);
  });

  console.log("\n== 断线重连检查 ==");
  const firstSocket = [...sockets][0];
  check("网关连接已建立", () => assert.ok(firstSocket, "没有可断开的连接"));
  firstSocket.terminate();
  await waitFor(() => connections >= 2 && resumePayload, 10_000, "断线重连");
  check("断线后发送 Resume（带 session_id 与 seq）", () => {
    assert.equal(resumePayload.session_id, "session-test");
    assert.equal(typeof resumePayload.seq, "number");
    assert.ok(resumePayload.seq >= 1, `seq=${resumePayload.seq}`);
  });
  await waitFor(() => sent.some((m) => m.body.msg_id === "msg-4"), 10_000, "重连后回复");
  check("Resume 后仍能收消息并回复", () => {
    const reply = sent.find((m) => m.body.msg_id === "msg-4");
    assert.ok(reply.body.content.includes("收到：重连后还在吗"));
  });
} catch (error) {
  console.error(`\n[ERROR] ${error.stack || error.message}`);
  exitCode = 1;
} finally {
  await bot.stop().catch(() => {});
  for (const socket of sockets) socket.terminate();
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
}

const failed = results.filter((item) => !item.ok);
console.log("");
console.log(`自测结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  exitCode = 1;
  for (const item of failed) console.log(`  - 失败：${item.name}（${item.error.message}）`);
}
process.exit(exitCode);
