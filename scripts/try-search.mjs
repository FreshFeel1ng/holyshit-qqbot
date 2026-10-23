import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import {
  SearchClient,
  SEARCH_TOOL,
  SEARCH_SYSTEM_HINT,
  formatSearchResults,
} from "../src/search.js";
import { WeatherClient, WEATHER_TOOL, WEATHER_SYSTEM_HINT } from "../src/weather.js";
import { NewsClient, NEWS_TOOL, NEWS_SYSTEM_HINT, formatNews } from "../src/news.js";
import { LlmClient } from "../src/llm.js";

const config = loadConfig();
const logger = createLogger("info");
const search = new SearchClient({ config, logger });
const weather = new WeatherClient({ config, logger });
const news = new NewsClient({ config, logger });
const llm = new LlmClient({ config, logger });

const question = process.argv[2] || "今天北京天气怎么样";
console.log(`\n问题：${question}\n`);

const startedAt = Date.now();
const answer = await llm.chatWithTools({
  messages: [
    {
      role: "system",
      content: [config.llm.systemPrompt, SEARCH_SYSTEM_HINT, WEATHER_SYSTEM_HINT, NEWS_SYSTEM_HINT].join("\n\n"),
    },
    { role: "user", content: question },
  ],
  tools: [SEARCH_TOOL, WEATHER_TOOL, NEWS_TOOL],
  onToolCall: async (name, args) => {
    console.log(`→ 模型调用工具：${name} ${JSON.stringify(args)}`);
    if (name === "get_weather") return weather.describe(args.city);
    if (name === "get_tech_news") {
      const items = await news.latest({ keyword: args.keyword });
      console.log(`  取到 ${items.length} 条新闻，首条：${items[0]?.title ?? "无"}`);
      return formatNews(items);
    }
    const results = await search.search(args.query);
    console.log(`  搜到 ${results.length} 条，首条：${results[0]?.title ?? "无"}`);
    return formatSearchResults(results);
  },
});

console.log(`\n回答（${Date.now() - startedAt}ms）：\n${answer}`);
