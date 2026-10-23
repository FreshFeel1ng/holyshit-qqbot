/**
 * 机器人 access_token 管理：默认 7200 秒有效，过期前 60 秒刷新。
 * 同一时刻只会发起一次刷新请求（single-flight）。
 */
export class TokenManager {
  #token = null;
  #expiresAt = 0;
  #inflight = null;

  constructor({ appId, appSecret, tokenUrl, timeoutMs = 15_000, logger }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.tokenUrl = tokenUrl;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
  }

  get token() {
    return this.#token;
  }

  get valid() {
    return Boolean(this.#token) && Date.now() < this.#expiresAt - 60_000;
  }

  invalidate() {
    this.#token = null;
    this.#expiresAt = 0;
  }

  /** 获取可用 token；必要时刷新。 */
  async get() {
    if (this.valid) return this.#token;
    return this.refresh();
  }

  /** 强制刷新（并发调用会复用同一个请求）。 */
  async refresh() {
    if (this.#inflight) return this.#inflight;
    this.#inflight = this.#doRefresh().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  async #doRefresh() {
    const startedAt = Date.now();
    let response;
    try {
      response = await fetch(this.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Error(`获取 access_token 失败（网络错误）：${error.message}`);
    }

    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`获取 access_token 失败：返回的不是 JSON（HTTP ${response.status}）`);
    }

    if (!response.ok || !data?.access_token) {
      const code = data?.code ?? data?.err_code ?? response.status;
      throw new Error(
        `获取 access_token 失败：code=${code} message=${data?.message ?? "未知错误"}（HTTP ${response.status}）`,
      );
    }

    const expiresIn = Number.parseInt(String(data.expires_in ?? "7200"), 10) || 7200;
    this.#token = data.access_token;
    this.#expiresAt = Date.now() + expiresIn * 1000;
    this.logger?.info(`access_token 已刷新，有效期 ${expiresIn}s（耗时 ${Date.now() - startedAt}ms）`);
    return this.#token;
  }
}
