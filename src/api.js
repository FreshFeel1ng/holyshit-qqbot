export class ApiError extends Error {
  constructor(message, { status, code, traceId, path } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.traceId = traceId;
    this.path = path;
  }
}

/** QQ 机器人 OpenAPI v2 客户端。 */
export class QQApi {
  constructor({ config, tokens, logger }) {
    this.base = config.apiBase;
    this.tokens = tokens;
    this.logger = logger;
  }

  async request(method, path, body, { retryOnAuth = true, timeoutMs = 20_000 } = {}) {
    const token = await this.tokens.get();
    const url = `${this.base}${path}`;

    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `QQBot ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "qq-group-bot/1.0",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ApiError(`${method} ${path} 网络错误：${error.message}`, { path });
    }

    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    // access_token 过期：刷新后重试一次
    if (response.status === 401 && retryOnAuth) {
      this.logger.warn(`${path} 返回 401，刷新 access_token 后重试`);
      this.tokens.invalidate();
      return this.request(method, path, body, { retryOnAuth: false, timeoutMs });
    }

    const code = data?.err_code ?? data?.code;
    if (!response.ok || (typeof code === "number" && code !== 0)) {
      throw new ApiError(
        `${method} ${path} 失败：code=${code ?? response.status} message=${data?.message ?? "未知错误"}` +
          (data?.trace_id ? ` trace_id=${data.trace_id}` : ""),
        { status: response.status, code, traceId: data?.trace_id, path },
      );
    }
    return data;
  }

  /** 发送群消息（被动回复需带 msg_id）。 */
  sendGroupMessage(groupOpenid, payload) {
    return this.request("POST", `/v2/groups/${encodeURIComponent(groupOpenid)}/messages`, payload);
  }

  /** 发送单聊消息。 */
  sendC2CMessage(userOpenid, payload) {
    return this.request("POST", `/v2/users/${encodeURIComponent(userOpenid)}/messages`, payload);
  }

  /** 获取 WebSocket 网关地址。/gateway/bot 不可用时回退到 /gateway。 */
  async getGateway() {
    try {
      return await this.request("GET", "/gateway/bot");
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.code === 10004)) {
        return this.request("GET", "/gateway");
      }
      throw error;
    }
  }

  /** 当前机器人信息（用于启动自检）。 */
  getMe() {
    return this.request("GET", "/users/@me");
  }
}
