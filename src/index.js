import { loadConfig, validateConfig, describeConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { TokenManager } from "./token.js";
import { QQApi } from "./api.js";
import { Gateway } from "./gateway.js";
import { LlmClient } from "./llm.js";
import { SearchClient } from "./search.js";
import { WeatherClient } from "./weather.js";
import { NewsClient } from "./news.js";
import { PersonaStore } from "./persona.js";
import { MemoryStore } from "./memory.js";
import { Responder } from "./responder.js";
import { Bot } from "./bot.js";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const problems = validateConfig(config);
  for (const problem of problems) logger.warn(`配置检查：${problem}`);

  if (!config.appId || !config.appSecret) {
    logger.error("缺少 BOT_APP_ID / BOT_APP_SECRET，无法连接 QQ 机器人平台。");
    logger.error("请复制 .env.example 为 .env，填入开放平台的 AppID 与 AppSecret 后重试。");
    logger.error("步骤见 README.md「第一步：注册并拿到 AppID/AppSecret」。");
    process.exitCode = 1;
    return;
  }

  if (!config.llm.apiKey) {
    logger.warn("未配置 LLM_API_KEY：机器人会以“回显模式”运行，只能复述用户的话。");
  }

  const info = describeConfig(config);
  logger.info("================ QQ 群聊机器人 ================");
  for (const [key, value] of Object.entries(info)) logger.info(`${key}：${value}`);
  logger.info("==============================================");

  const tokens = new TokenManager({
    appId: config.appId,
    appSecret: config.appSecret,
    tokenUrl: config.tokenUrl,
    logger: logger.child("token"),
  });

  try {
    await tokens.refresh();
  } catch (error) {
    logger.error(error.message);
    logger.error("常见原因：AppID/AppSecret 填错（100016）、机器人不存在（10004）、机器人状态异常（100007）。");
    process.exitCode = 1;
    return;
  }

  const api = new QQApi({ config, tokens, logger: logger.child("api") });
  const gateway = new Gateway({ api, tokens, config, logger: logger.child("gateway") });
  const llm = new LlmClient({ config, logger: logger.child("llm") });
  const search = new SearchClient({ config, logger: logger.child("search") });
  void search.warmup();
  const weather = new WeatherClient({ config, logger: logger.child("weather") });
  const news = new NewsClient({ config, logger: logger.child("news") });
  const memory = new MemoryStore({
    dir: config.dataDir,
    maxTurns: config.llm.historyTurns,
    logger: logger.child("memory"),
  });
  await memory.init();

  const persona = new PersonaStore({
    dir: config.dataDir,
    maxRules: config.persona.maxRules,
    logger: logger.child("persona"),
  });
  await persona.init();

  const responder = new Responder({ api, config, logger: logger.child("reply") });
  const bot = new Bot({ config, api, gateway, llm, memory, responder, search, weather, news, persona, logger: logger.child("bot") });

  const shutdown = async (signal) => {
    logger.info(`收到 ${signal}，正在关闭…`);
    try {
      await bot.stop();
    } catch (error) {
      logger.warn(`关闭时出错：${error.message}`);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    logger.error(`未处理的 Promise 拒绝：${reason instanceof Error ? reason.stack : reason}`);
  });
  process.on("uncaughtException", (error) => {
    logger.error(`未捕获异常：${error.stack || error.message}`);
  });

  // 4914/4915 这类致命错误无法靠重连恢复，直接退出并由守护进程决定是否重启
  gateway.on("fatal", (error) => {
    logger.error(`连接已终止：${error.message}`);
    void shutdown("fatal");
  });

  await bot.start();
  logger.info("启动完成，按 Ctrl+C 退出。");
}

main().catch((error) => {
  console.error("启动失败：", error);
  process.exit(1);
});
