import { parseRssItems } from "./rss.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export class NewsError extends Error {
  constructor(message) {
    super(message);
    this.name = "NewsError";
  }
}

/**
 * 科技新闻聚合：读若干 RSS 源，按时间倒序取最新若干条，可按关键词筛选。
 * 默认源是 IT之家（更新快、条目全）。
 */
export class NewsClient {
  constructor({ config, logger }) {
    this.cfg = config.news;
    this.logger = logger;
  }

  get enabled() {
    return this.cfg.enabled && this.cfg.feeds.length > 0;
  }

  /**
   * @param {{keyword?: string, limit?: number}} options
   * @returns {Promise<{title: string, url: string, snippet: string, date: string, source: string}[]>}
   */
  async latest({ keyword = "", limit = this.cfg.maxItems } = {}) {
    const startedAt = Date.now();
    const settled = await Promise.allSettled(this.cfg.feeds.map((feed) => this.#fetchFeed(feed)));

    const items = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") {
        items.push(...result.value);
      } else {
        this.logger.warn(`新闻源「${this.cfg.feeds[index].name}」获取失败：${result.reason.message}`);
      }
    });

    if (!items.length) throw new NewsError("所有新闻源都获取失败");

    const keywordText = String(keyword ?? "").trim();
    let filtered = keywordText
      ? items.filter((item) => `${item.title} ${item.snippet}`.includes(keywordText))
      : items;
    if (!filtered.length) {
      this.logger.info(`关键词「${keywordText}」没有命中，改为返回最新新闻`);
      filtered = items;
    }

    filtered.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

    const seen = new Set();
    const output = [];
    for (const item of filtered) {
      const key = item.title.slice(0, 40);
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(item);
      if (output.length >= limit) break;
    }

    this.logger.info(
      `新闻聚合 ${output.length} 条（${Date.now() - startedAt}ms${keywordText ? `，关键词「${keywordText}」` : ""}）`,
    );
    return output;
  }

  async #fetchFeed(feed) {
    let response;
    try {
      response = await fetch(feed.url, {
        headers: { "User-Agent": USER_AGENT, "Accept-Language": "zh-CN,zh;q=0.9" },
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
        redirect: "follow",
      });
    } catch (error) {
      throw new NewsError(`请求失败：${error.message}`);
    }
    if (!response.ok) throw new NewsError(`HTTP ${response.status}`);
    const xml = await response.text();
    return parseRssItems(xml, 40).map((item) => ({ ...item, source: feed.name }));
  }
}

/** 给模型看的新闻列表（标题 + 日期 + 一句摘要，不带 URL）。 */
export function formatNews(items) {
  return items
    .map((item, index) => {
      const date = item.date ? `（${item.date}）` : "";
      const source = item.source ? ` 来源：${item.source}` : "";
      return `[${index + 1}] ${item.title}${date}${source}\n${item.snippet || "（无摘要）"}`;
    })
    .join("\n\n");
}

export const NEWS_TOOL = {
  type: "function",
  function: {
    name: "get_tech_news",
    description:
      "获取科技圈最新新闻标题（来自 IT之家等 RSS 源，通常是最近一两天的内容）。" +
      "用户问“最近有什么新闻 / 科技圈有什么大事 / 今天有什么新鲜事”时调用。",
    parameters: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "可选，筛选关键词，例如「苹果」「AI」「芯片」" },
      },
      required: [],
    },
  },
};

export const NEWS_SYSTEM_HINT =
  "用户问最近新闻、科技圈动态时，先调用 get_tech_news 拿最新标题，再把它们归纳成 2~3 条要点；" +
  "不要逐条罗列全部标题，也不要编造没看到的细节。";
