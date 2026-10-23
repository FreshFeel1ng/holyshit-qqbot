import { EventEmitter } from "node:events";
import WebSocket from "ws";

const FATAL_CODES = new Set([4914, 4915]);
/** 这些关闭码表示 session 已失效，必须重新 Identify。 */
const IDENTIFY_CODES = new Set([4006, 4007, 4008, 4010, 4011, 4012, 4013, 4014]);
/** 这些关闭码允许 Resume 继续。 */
const RESUME_CODES = new Set([4009]);

const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
};

const DEFAULT_GATEWAY = "wss://api.bot.qq.com/websocket/";

/**
 * QQ 机器人 WebSocket 网关：心跳、Identify/Resume、断线重连。
 * 事件：ready / resumed / event / fatal / close
 */
export class Gateway extends EventEmitter {
  #ws = null;
  #seq = null;
  #sessionId = null;
  #heartbeatTimer = null;
  #ackTimer = null;
  #reconnectTimer = null;
  #stopped = false;
  #backoffMs = 1000;
  #ready = false;

  constructor({ api, tokens, config, logger }) {
    super();
    this.api = api;
    this.tokens = tokens;
    this.config = config;
    this.logger = logger;
  }

  get sessionId() {
    return this.#sessionId;
  }

  get connected() {
    return this.#ready;
  }

  async start() {
    this.#stopped = false;
    await this.#connect();
  }

  async stop() {
    this.#stopped = true;
    this.#clearTimers();
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    const ws = this.#ws;
    this.#ws = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close(1000, "client shutdown");
    }
  }

  async #resolveGatewayUrl() {
    if (this.config.gatewayUrlOverride) return this.config.gatewayUrlOverride;
    try {
      const info = await this.api.getGateway();
      if (info?.url) {
        this.logger.debug(`网关分片建议：${info.shards ?? 1}`);
        return info.url;
      }
    } catch (error) {
      this.logger.warn(`获取网关地址失败，使用默认地址：${error.message}`);
    }
    return DEFAULT_GATEWAY;
  }

  async #connect() {
    if (this.#stopped) return;

    let url;
    try {
      url = await this.#resolveGatewayUrl();
    } catch (error) {
      this.logger.error(`无法获取网关地址：${error.message}`);
      this.#scheduleReconnect();
      return;
    }

    this.logger.info(`正在连接网关：${url}`);
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (error) {
      this.logger.error(`WebSocket 创建失败：${error.message}`);
      this.#scheduleReconnect();
      return;
    }
    this.#ws = ws;

    ws.on("open", () => {
      this.logger.debug("WebSocket 已建立，等待 Hello 下发");
    });

    ws.on("message", (raw) => {
      this.#onMessage(raw, ws);
    });

    ws.on("error", (error) => {
      this.logger.warn(`WebSocket 错误：${error.message}`);
    });

    ws.on("close", (code, reason) => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#clearTimers();
      this.#ready = false;
      const text = reason?.toString() || "";
      this.logger.warn(`WebSocket 关闭：code=${code}${text ? ` reason=${text}` : ""}`);
      this.emit("close", { code, reason: text });
      if (!this.#stopped) this.#onClose(code);
    });
  }

  #onClose(code) {
    if (FATAL_CODES.has(code)) {
      const message =
        code === 4914
          ? "机器人已下架，只允许连接沙箱环境。请先在管理端上架/恢复。"
          : "机器人已被封禁，无法连接。";
      this.logger.error(message);
      this.#stopped = true;
      this.emit("fatal", new Error(message));
      return;
    }

    if (IDENTIFY_CODES.has(code)) {
      this.logger.info("会话不可恢复，将重新 Identify");
      this.#sessionId = null;
      this.#seq = null;
      this.#scheduleReconnect(true);
      return;
    }

    if (RESUME_CODES.has(code) || (code >= 4900 && code <= 4913)) {
      this.logger.info("连接过期，将尝试 Resume");
      this.#scheduleReconnect(true);
      return;
    }

    this.#scheduleReconnect();
  }

  #scheduleReconnect(immediate = false) {
    if (this.#stopped || this.#reconnectTimer) return;
    const delay = immediate ? 500 : Math.min(this.#backoffMs, 30_000);
    this.#backoffMs = Math.min(this.#backoffMs * 2, 30_000);
    const wait = delay + Math.floor(Math.random() * 400);
    this.logger.info(`${Math.round(wait / 100) / 10}s 后重连`);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect().catch((error) => {
        this.logger.error(`重连失败：${error.message}`);
        this.#scheduleReconnect();
      });
    }, wait);
  }

  #onMessage(raw, ws) {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      this.logger.warn("收到无法解析的网关消息");
      return;
    }

    switch (payload.op) {
      case OP.HELLO: {
        const interval = Number(payload.d?.heartbeat_interval) || 45_000;
        this.logger.debug(`收到 Hello，心跳间隔 ${interval}ms`);
        this.#startHeartbeat(interval, ws);
        this.#authenticate(ws).catch((error) => {
          this.logger.error(`鉴权失败：${error.message}`);
          try {
            ws.close(4000, "auth failed");
          } catch {
            /* ignore */
          }
        });
        break;
      }
      case OP.HEARTBEAT_ACK: {
        if (this.#ackTimer) {
          clearTimeout(this.#ackTimer);
          this.#ackTimer = null;
        }
        break;
      }
      case OP.HEARTBEAT: {
        this.#send(ws, { op: OP.HEARTBEAT, d: this.#seq });
        break;
      }
      case OP.DISPATCH: {
        this.#handleDispatch(payload);
        break;
      }
      case OP.RECONNECT: {
        this.logger.info("网关要求重连");
        ws.close(4000, "server requested reconnect");
        break;
      }
      case OP.INVALID_SESSION: {
        this.logger.warn("会话无效（Invalid Session），将重新 Identify");
        this.#sessionId = null;
        this.#seq = null;
        ws.close(4000, "invalid session");
        break;
      }
      default:
        this.logger.debug(`未处理的 opcode=${payload.op}`);
    }
  }

  #handleDispatch(payload) {
    if (typeof payload.s === "number") this.#seq = payload.s;

    if (payload.t === "READY") {
      this.#sessionId = payload.d?.session_id ?? null;
      this.#ready = true;
      this.#backoffMs = 1000;
      this.logger.info(
        `网关鉴权成功，机器人：${payload.d?.user?.username ?? "未知"}（session=${String(this.#sessionId).slice(0, 8)}…）`,
      );
      this.emit("ready", payload.d);
      return;
    }

    if (payload.t === "RESUMED") {
      this.#ready = true;
      this.#backoffMs = 1000;
      this.logger.info("会话已恢复（RESUMED）");
      this.emit("resumed");
      return;
    }

    this.emit("event", { t: payload.t, d: payload.d, id: payload.id, s: payload.s });
  }

  #startHeartbeat(interval, ws) {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = setInterval(() => {
      this.#send(ws, { op: OP.HEARTBEAT, d: this.#seq });
      if (this.#ackTimer) clearTimeout(this.#ackTimer);
      this.#ackTimer = setTimeout(() => {
        this.logger.warn("心跳 ACK 超时，主动重连");
        this.#ackTimer = null;
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
      }, Math.max(5000, interval * 1.5));
    }, interval);
  }

  async #authenticate(ws) {
    // 网关可能先于任何 API 调用建立，这里必须确保 token 已就绪
    const accessToken = await this.tokens.get();
    const token = `QQBot ${accessToken}`;
    if (ws.readyState !== WebSocket.OPEN) return;
    if (this.#sessionId && this.#seq !== null) {
      this.#send(ws, {
        op: OP.RESUME,
        d: { token, session_id: this.#sessionId, seq: this.#seq },
      });
      this.logger.info("已发送 Resume");
      return;
    }

    this.#send(ws, {
      op: OP.IDENTIFY,
      d: {
        token,
        intents: this.config.intents,
        shard: [0, 1],
        properties: {
          $os: process.platform,
          $browser: "qq-group-bot",
          $device: "qq-group-bot",
        },
      },
    });
    this.logger.info(`已发送 Identify（intents=${this.config.intents}）`);
  }

  #send(ws, payload) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  }

  #clearTimers() {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    if (this.#ackTimer) {
      clearTimeout(this.#ackTimer);
      this.#ackTimer = null;
    }
  }
}
