import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const VERSION = 1;

/**
 * 会话记忆：按 群+成员 / 单聊用户 保存最近若干轮对话，落盘为一个 JSON 文件。
 * 过期会话在读取和落盘时自动清理。
 */
export class MemoryStore {
  #data = { version: VERSION, conversations: {} };
  #file;
  #maxTurns;
  #ttlMs;
  #maxConversations = 500;
  #saveTimer = null;
  #saving = null;
  #logger;

  constructor({ dir, maxTurns = 10, ttlMs = 2 * 60 * 60 * 1000, logger }) {
    this.#file = path.join(dir, "memory.json");
    this.#maxTurns = maxTurns;
    this.#ttlMs = ttlMs;
    this.#logger = logger;
  }

  async init() {
    await mkdir(path.dirname(this.#file), { recursive: true });
    try {
      const raw = await readFile(this.#file, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.conversations) {
        this.#data = { version: VERSION, conversations: parsed.conversations };
      }
      this.#prune();
      this.#logger.info(`已加载会话记忆：${Object.keys(this.#data.conversations).length} 个会话`);
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.#logger.warn(`读取会话记忆失败，将从空开始：${error.message}`);
      }
    }
  }

  get(key) {
    const entry = this.#data.conversations[key];
    if (!entry) return [];
    if (Date.now() - entry.updatedAt > this.#ttlMs) {
      delete this.#data.conversations[key];
      return [];
    }
    return entry.messages.slice();
  }

  append(key, userText, assistantText) {
    const now = Date.now();
    const entry = this.#data.conversations[key] ?? { updatedAt: now, messages: [] };
    entry.updatedAt = now;
    entry.messages.push({ role: "user", content: userText });
    entry.messages.push({ role: "assistant", content: assistantText });
    const limit = this.#maxTurns * 2;
    if (entry.messages.length > limit) entry.messages = entry.messages.slice(-limit);
    this.#data.conversations[key] = entry;
    this.#prune();
    this.#scheduleSave();
  }

  clear(key) {
    const existed = Boolean(this.#data.conversations[key]);
    delete this.#data.conversations[key];
    if (existed) this.#scheduleSave();
    return existed;
  }

  #prune() {
    const now = Date.now();
    const entries = Object.entries(this.#data.conversations);
    for (const [key, entry] of entries) {
      if (!entry || now - (entry.updatedAt ?? 0) > this.#ttlMs) {
        delete this.#data.conversations[key];
      }
    }
    const remaining = Object.entries(this.#data.conversations);
    if (remaining.length > this.#maxConversations) {
      remaining
        .sort((a, b) => (a[1].updatedAt ?? 0) - (b[1].updatedAt ?? 0))
        .slice(0, remaining.length - this.#maxConversations)
        .forEach(([key]) => delete this.#data.conversations[key]);
    }
  }

  #scheduleSave() {
    if (this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      this.save().catch((error) => this.#logger.warn(`保存会话记忆失败：${error.message}`));
    }, 1500);
  }

  async save() {
    if (this.#saving) return this.#saving;
    this.#saving = (async () => {
      this.#prune();
      const tmp = `${this.#file}.tmp`;
      await writeFile(tmp, JSON.stringify(this.#data), "utf8");
      await rename(tmp, this.#file);
    })().finally(() => {
      this.#saving = null;
    });
    return this.#saving;
  }

  /** 退出前落盘。 */
  async close() {
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
    }
    await this.save();
  }
}
