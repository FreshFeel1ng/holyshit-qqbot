const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class LlmError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "LlmError";
    this.status = status;
    this.body = body;
  }
}

/**
 * OpenAI Chat Completions 兼容客户端（DeepSeek / 通义 / Kimi / Ollama 等）。
 * 支持 function calling（联网搜索），未配置 API Key 时退化为回显模式。
 */
export class LlmClient {
  constructor({ config, logger }) {
    this.cfg = config.llm;
    this.logger = logger;
  }

  get enabled() {
    return Boolean(this.cfg.apiKey);
  }

  get modeLabel() {
    return this.enabled ? `${this.cfg.model}` : "回显模式（未配置 LLM_API_KEY）";
  }

  /**
   * 普通对话。
   * @param {{role: string, content: string}[]} messages
   * @returns {Promise<string>}
   */
  async chat(messages) {
    if (!this.enabled) return this.#echo(messages);
    const data = await this.#callWithRetry({
      model: this.cfg.model,
      messages,
      temperature: this.cfg.temperature,
      max_tokens: this.cfg.maxTokens,
      stream: false,
    });
    return this.#extractContent(data);
  }

  /**
   * 带工具的对话：模型需要时会请求调用工具，由 onToolCall 执行后回填结果，最多 maxRounds 轮。
   * @param {{messages: any[], tools: any[], onToolCall: (name: string, args: any) => Promise<string>, maxRounds?: number}} params
   */
  async chatWithTools({ messages, tools, onToolCall, maxRounds = 3 }) {
    if (!this.enabled) return this.#echo(messages);

    const conversation = [...messages];
    for (let round = 0; round < maxRounds; round += 1) {
      const data = await this.#callWithRetry({
        model: this.cfg.model,
        messages: conversation,
        temperature: this.cfg.temperature,
        max_tokens: this.cfg.maxTokens,
        stream: false,
        tools,
        tool_choice: "auto",
      });

      const message = data?.choices?.[0]?.message;
      const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];

      if (toolCalls.length) {
        conversation.push({
          role: "assistant",
          content: message.content ?? "",
          tool_calls: toolCalls,
        });

        for (const call of toolCalls) {
          const name = call?.function?.name ?? "unknown";
          let args = {};
          try {
            args = JSON.parse(call?.function?.arguments || "{}");
          } catch {
            args = {};
          }
          let result;
          try {
            result = await onToolCall(name, args);
          } catch (error) {
            this.logger.warn(`工具 ${name} 执行失败：${error.message}`);
            result = `工具执行失败：${error.message}。请直接根据已有知识回答，并说明信息可能不是最新的。`;
          }
          conversation.push({
            role: "tool",
            tool_call_id: call.id,
            content: String(result).slice(0, 6000),
          });
        }
        continue;
      }

      const content = typeof message?.content === "string" ? message.content.trim() : "";
      if (!content) throw new LlmError("大模型返回了空内容", { body: data });
      return content;
    }

    // 工具轮次用尽：强制要一个最终回答
    this.logger.warn(`工具调用达到上限（${maxRounds} 轮），强制收尾`);
    return this.chat(conversation);
  }

  #echo(messages) {
    const lastUser = [...messages].reverse().find((item) => item.role === "user");
    return `（还没接上大模型，先复述一下你的话）${lastUser?.content ?? ""}`.slice(0, 300);
  }

  #extractContent(data) {
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new LlmError("大模型返回了空内容", { body: data });
    }
    return content.trim();
  }

  async #callWithRetry(body) {
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return await this.#request(body);
      } catch (error) {
        lastError = error;
        if (error instanceof LlmError && error.status && error.status < 500 && error.status !== 429) {
          break;
        }
        if (attempt === 1) {
          this.logger.warn(`大模型调用异常：${error.message}，1.5s 后重试`);
          await sleep(1500);
        }
      }
    }
    throw lastError instanceof Error ? lastError : new LlmError("大模型调用失败");
  }

  async #request(body) {
    let response;
    try {
      response = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new LlmError(`大模型请求超时（>${Math.round(this.cfg.timeoutMs / 1000)}s）`);
      }
      throw new LlmError(`大模型网络错误：${error.message}`);
    }

    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (!response.ok) {
      throw new LlmError(
        `大模型接口返回 HTTP ${response.status}：${data?.error?.message ?? text.slice(0, 200)}`,
        { status: response.status, body: data },
      );
    }
    return data;
  }
}
