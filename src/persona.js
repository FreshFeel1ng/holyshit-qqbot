import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const VERSION = 1;
const MAX_RULE_LENGTH = 120;

/**
 * 群内人设规则：群友提的“以后说话要……”要求按群保存，实时叠加到系统提示词上。
 * 规则有数量上限（默认 5 条），超出后挤掉最早的；群主/管理员可一键重置。
 */
export class PersonaStore {
  #data = { version: VERSION, groups: {} };
  #file;
  #maxRules;
  #logger;
  #saveTimer = null;

  constructor({ dir, maxRules = 5, logger }) {
    this.#file = path.join(dir, "personas.json");
    this.#maxRules = maxRules;
    this.#logger = logger;
  }

  async init() {
    await mkdir(path.dirname(this.#file), { recursive: true });
    try {
      const raw = await readFile(this.#file, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.groups) this.#data = { version: VERSION, groups: parsed.groups };
      const count = Object.values(this.#data.groups).reduce(
        (sum, group) => sum + (group.rules?.length ?? 0),
        0,
      );
      this.#logger.info(`已加载人设规则：${Object.keys(this.#data.groups).length} 个群 / ${count} 条`);
    } catch (error) {
      if (error.code !== "ENOENT") this.#logger.warn(`读取人设规则失败，将从空开始：${error.message}`);
    }
  }

  getRules(key) {
    return (this.#data.groups[key]?.rules ?? []).map((rule) => ({ ...rule }));
  }

  /** @returns {{ok: boolean, reason?: string, rules?: object[]}} */
  addRule(key, text, by) {
    const clean = String(text ?? "")
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_RULE_LENGTH);
    if (!clean) return { ok: false, reason: "empty" };

    const entry = this.#data.groups[key] ?? { rules: [], updatedAt: 0 };
    const existing = entry.rules.find((rule) => rule.text === clean);
    if (existing) {
      existing.at = Date.now();
      existing.by = by;
    } else {
      entry.rules.push({ text: clean, by, at: Date.now() });
    }
    while (entry.rules.length > this.#maxRules) entry.rules.shift();

    entry.updatedAt = Date.now();
    this.#data.groups[key] = entry;
    this.#scheduleSave();
    this.#logger.info(`群 ${String(key).slice(0, 8)}… 人设规则 +1（${by}）：${clean}`);
    return { ok: true, rules: this.getRules(key) };
  }

  reset(key) {
    if (!this.#data.groups[key]) return false;
    delete this.#data.groups[key];
    this.#scheduleSave();
    this.#logger.info(`群 ${String(key).slice(0, 8)}… 人设规则已重置`);
    return true;
  }

  #scheduleSave() {
    if (this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      this.save().catch((error) => this.#logger.warn(`保存人设规则失败：${error.message}`));
    }, 800);
  }

  async save() {
    const tmp = `${this.#file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.#data, null, 2), "utf8");
    await rename(tmp, this.#file);
  }

  async close() {
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
    }
    await this.save().catch(() => {});
  }
}

const PERSONA_NOUN = /(人设|性格|语气|口癖|说话方式|说话风格|称呼|自称)/;
const PERSONA_CHANGE = /(改|设置|设为|变成|调整|换成|加|去掉|别|不要|以后|今后|记住|保持)/;

/**
 * 判断一句话是不是在提“以后怎么说话”的要求。
 * 两类命中：①以「以后/记住/请…」开头；②同时提到人设类词 + 修改类动词。
 */
export function looksLikePersonaInstruction(text) {
  const value = String(text ?? "").trim();
  if (value.length < 4 || value.length > MAX_RULE_LENGTH) return false;

  if (/^(?:你|您)?\s*(?:以后|今后|从现在开始|从现在起|接下来|你得|你要|记住|请|麻烦)/.test(value)) {
    return true;
  }
  return PERSONA_NOUN.test(value) && PERSONA_CHANGE.test(value);
}
