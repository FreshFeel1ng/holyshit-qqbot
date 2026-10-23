import { loadConfig, validateConfig, describeConfig } from "../src/config.js";

const config = loadConfig();

console.log("========== QQ 群聊机器人 配置自检 ==========");
for (const [key, value] of Object.entries(describeConfig(config))) {
  console.log(`  ${key.padEnd(8)}: ${value}`);
}
console.log("");

const problems = validateConfig(config);
if (problems.length) {
  for (const problem of problems) console.log(`  [WARN] ${problem}`);
  console.log("");
}

if (!config.appId || !config.appSecret) {
  console.log("[FAIL] 尚未填写 BOT_APP_ID / BOT_APP_SECRET。");
  console.log("       1) 复制 .env.example 为 .env");
  console.log("       2) 到 https://q.qq.com 创建机器人，复制「开发设置」里的 AppID/AppSecret");
  console.log("       3) 重新运行 npm run check");
  process.exit(1);
}

const timeout = AbortSignal.timeout(15_000);

async function getToken() {
  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId: config.appId, clientSecret: config.appSecret }),
    signal: timeout,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.access_token) {
    const code = data?.code ?? data?.err_code ?? response.status;
    const hints = {
      100016: "AppID 或 AppSecret 不正确，请与管理端「开发设置」逐字核对",
      100007: "AppID 无效，或机器人处于封禁/删除状态",
      10004: "机器人不存在：确认 AppID 是否属于当前登录账号",
      100001: "请求过于频繁，稍等一会儿再试",
    };
    throw new Error(`获取 access_token 失败：code=${code} ${data?.message ?? ""}${hints[code] ? `\n       提示：${hints[code]}` : ""}`);
  }
  return data;
}

try {
  const data = await getToken();
  console.log(`[OK] access_token 获取成功（有效期 ${data.expires_in}s）`);

  const headers = { Authorization: `QQBot ${data.access_token}` };

  const meResponse = await fetch(`${config.apiBase}/users/@me`, { headers, signal: timeout });
  const me = await meResponse.json().catch(() => null);
  if (meResponse.ok && me?.username) {
    console.log(`[OK] 机器人身份：${me.username}（id=${me.id}）`);
  } else {
    console.log(`[WARN] 查询机器人信息失败：HTTP ${meResponse.status} ${me?.message ?? ""}`);
  }

  const gatewayResponse = await fetch(`${config.apiBase}/gateway/bot`, { headers, signal: timeout });
  const gateway = await gatewayResponse.json().catch(() => null);
  if (gatewayResponse.ok && gateway?.url) {
    console.log(`[OK] 网关地址：${gateway.url}（建议分片 ${gateway.shards ?? 1}）`);
  } else {
    console.log(`[WARN] 查询网关失败：HTTP ${gatewayResponse.status} ${gateway?.message ?? ""}`);
  }

  if (!config.llm.apiKey) {
    console.log("[WARN] LLM_API_KEY 未填写：机器人会以回显模式运行，无法真正聊天。");
  } else {
    console.log(`[OK] 大模型配置：${config.llm.model} @ ${config.llm.baseUrl}`);
  }

  if (config.search.provider === "tavily" || config.search.tavilyApiKey) {
    try {
      const response = await fetch(config.search.tavilyEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.search.tavilyApiKey}`,
        },
        body: JSON.stringify({ api_key: config.search.tavilyApiKey, query: "DeepSeek", max_results: 1 }),
        signal: timeout,
      });
      if (response.ok) {
        const data = await response.json().catch(() => null);
        const count = data?.results?.length ?? 0;
        console.log(`[OK] Tavily 可用（返回 ${count} 条）`);
      } else if (response.status === 401 || response.status === 403) {
        console.log("[FAIL] Tavily API Key 无效，请到 https://app.tavily.com 重新复制");
      } else if (response.status === 429) {
        console.log("[WARN] Tavily 额度用尽或限流，机器人会自动回退到必应");
      } else {
        console.log(`[WARN] Tavily 返回 HTTP ${response.status}`);
      }
    } catch (error) {
      console.log(`[WARN] Tavily 连接失败：${error.message}（机器人会自动回退到必应）`);
    }
  } else {
    console.log("[OK] 搜索使用必应（未配置 Tavily，可选）");
  }

  console.log("");
  console.log("全部关键检查通过。下一步：npm start");
} catch (error) {
  console.log(`[FAIL] ${error.message}`);
  process.exit(1);
}
