const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 被动回复每条消息最多 5 次（官方限制）。 */
const MAX_REPLIES_PER_MESSAGE = 5;

/**
 * 按字数切分长回复，尽量落在段落/句子边界，最多 maxChunks 段。
 * @returns {string[]}
 */
export function splitMessage(text, maxChars = 700, maxChunks = 3) {
  const clean = String(text ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const chunks = [];
  let rest = clean;

  while (rest && chunks.length < maxChunks) {
    if (rest.length <= maxChars) {
      chunks.push(rest);
      rest = "";
      break;
    }

    const window = rest.slice(0, maxChars);
    let cut = -1;
    for (const marker of ["\n\n", "\n", "。", "！", "？", "；", " "]) {
      const index = window.lastIndexOf(marker);
      if (index >= maxChars * 0.5) {
        cut = index + marker.length;
        break;
      }
    }
    if (cut <= 0) cut = maxChars;

    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) chunks[chunks.length - 1] += "…";
  return chunks.filter(Boolean);
}

/** 按 key（群）做最小发送间隔控制，避免触发单群 20 条/分钟的频控。 */
export class RateLimiter {
  #nextAt = new Map();

  constructor({ minIntervalMs = 3200, logger } = {}) {
    this.minIntervalMs = minIntervalMs;
    this.logger = logger;
  }

  async wait(key) {
    if (this.minIntervalMs <= 0) return;
    const now = Date.now();
    const readyAt = Math.max(now, this.#nextAt.get(key) ?? 0);
    if (readyAt > now) {
      this.logger?.debug(`群 ${String(key).slice(0, 8)}… 限速等待 ${readyAt - now}ms`);
      await sleep(readyAt - now);
    }
    this.#nextAt.set(key, Math.max(Date.now(), readyAt) + this.minIntervalMs);
    if (this.#nextAt.size > 2000) {
      const edge = Date.now();
      for (const [k, v] of this.#nextAt) if (v < edge) this.#nextAt.delete(k);
    }
  }
}

/** 负责把一段回复安全地发到群/单聊：切分、限速、msg_seq 递增、错误归类。 */
export class Responder {
  #seq = new Map();
  #limiter;

  constructor({ api, config, logger }) {
    this.api = api;
    this.config = config;
    this.logger = logger;
    this.#limiter = new RateLimiter({
      minIntervalMs: config.reply.minIntervalMs,
      logger,
    });
  }

  replyGroup(groupOpenid, msgId, text) {
    return this.#send("group", groupOpenid, msgId, text);
  }

  replyC2C(userOpenid, msgId, text) {
    return this.#send("c2c", userOpenid, msgId, text);
  }

  async #send(kind, target, msgId, text) {
    const chunks = splitMessage(text, this.config.reply.maxChars, this.config.reply.maxChunks);
    if (!chunks.length) return 0;

    const label = kind === "group" ? `群 ${String(target).slice(0, 8)}…` : `用户 ${String(target).slice(0, 8)}…`;
    let sent = 0;

    for (const [index, chunk] of chunks.entries()) {
      let content = chunk;
      let attempt = 0;

      while (attempt < 2) {
        attempt += 1;
        const seq = this.#nextSeq(msgId);
        if (seq > MAX_REPLIES_PER_MESSAGE) {
          this.logger.warn(`${label} 对同一条消息已回复 ${MAX_REPLIES_PER_MESSAGE} 次，放弃剩余内容`);
          return sent;
        }

        await this.#limiter.wait(target);

        const payload = {
          content,
          msg_type: 0,
          msg_id: msgId,
          msg_seq: seq,
        };

        try {
          if (kind === "group") await this.api.sendGroupMessage(target, payload);
          else await this.api.sendC2CMessage(target, payload);
          sent += 1;
          this.logger.info(
            `${label} 已发送第 ${index + 1}/${chunks.length} 段（${content.length} 字，msg_seq=${seq}）`,
          );
          break;
        } catch (error) {
          const code = error.code;
          // 群聊里机器人不允许直接发 URL：去掉链接后重试一次
          if (code === 40054010 && attempt === 1 && /https?:\/\/\S+/i.test(content)) {
            content = content.replace(/https?:\/\/\S+/gi, "（链接已省略）");
            this.logger.warn(`${label} 触发「不允许发送URL」，已移除链接后重试`);
            continue;
          }
          this.#logSendError(label, code, error);
          return sent;
        }
      }
    }

    return sent;
  }

  #logSendError(label, code, error) {
    if (code === 40034005 || code === 40034128 || code === 40054005) {
      this.logger.warn(`${label} 发送失败（被动回复窗口/去重限制，code=${code}）：${error.message}`);
    } else if (code === 40034100) {
      this.logger.warn(`${label} 发送失败：触发主动消息频控（code=${code}）`);
    } else if (code === 1100101 || code === 40034006) {
      this.logger.warn(`${label} 消息内容被安全策略拦截（code=${code}），请调整回复内容`);
    } else if (code === 40054007) {
      this.logger.warn(`${label} 消息过长被拒（code=${code}），可调小 REPLY_MAX_CHARS`);
    } else {
      this.logger.error(`${label} 发送失败：${error.message}`);
    }
  }

  #nextSeq(msgId) {
    const now = Date.now();
    if (this.#seq.size > 1000) {
      for (const [id, entry] of this.#seq) {
        if (now - entry.at > 5 * 60 * 1000) this.#seq.delete(id);
      }
    }
    const entry = this.#seq.get(msgId) ?? { count: 0, at: now };
    entry.count += 1;
    entry.at = now;
    this.#seq.set(msgId, entry);
    return entry.count;
  }
}
