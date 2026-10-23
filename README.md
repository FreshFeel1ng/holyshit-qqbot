# holyshit-qqbot

一个跑在 **QQ 官方机器人开放平台** 上的群聊 AI 机器人：群里 @ 它就能聊天，也支持私聊。
纯 Node.js 实现，不注入客户端、不使用第三方协议端，不存在封号风险。

- 群 @ 回复 / 私聊对话，会话记忆按人隔离
- 联网搜索（Tavily / 必应，自动降级）、实时天气、科技新闻，由模型自己决定何时调用
- 群友可以**直接在群里改它的人设**（「以后说话结尾加喵～」），立即生效、按群保存
- 长回复自动分条、按群限速、重复消息去重、断线自动恢复

```
QQ 客户端 ──@机器人──▶ QQ 官方网关 (WebSocket) ──▶ 本服务 ──▶ 大模型 API
                                   ▲                          │
                                   └──── 被动回复 (HTTPS) ◀────┘
                                       搜索 / 天气 / 新闻
```

## 特性

| 能力 | 说明 |
| --- | --- |
| 对话 | 群内被 @ 或私聊时回复，每个用户独立上下文（默认 10 轮 / 2 小时过期，持久化） |
| 联网 | `web_search` / `get_weather` / `get_tech_news` 三个工具，模型按需调用，最多 3 轮 |
| 人设 | 群友自助修改，按群隔离保存；群主可 `/人设 reset` 还原 |
| 稳定性 | access_token 自动刷新、WebSocket 心跳 + Resume 重连、失败降级 |
| 平台规则 | 被动回复 5 分钟 / 每条消息最多 5 次、单群 20 条/分钟、自动去重、禁止 URL 时自动去链接重试 |

## 快速开始

```bash
git clone https://github.com/FreshFeel1ng/holyshit-qqbot.git
cd holyshit-qqbot
npm install

cp .env.example .env      # Windows: copy .env.example .env
# 填入 BOT_APP_ID / BOT_APP_SECRET / LLM_API_KEY

npm run check             # 自检：拉 token、查机器人身份、验证搜索通道
npm start
```

然后在手机 QQ 里把机器人拉进群（见下文「把机器人加进群」），@ 它即可。

## 一、注册机器人

1. 打开 <https://q.qq.com>，用手机 QQ 扫码登录，完成主体认证（个人认证需实名）。
2. 「机器人」→「创建机器人」，填写名称、头像、简介。
3. 进入管理端 →「开发设置」，复制 **AppID** 和 **AppSecret**。

> 个人主体目前不支持公开上架，但可以把自己是群主/管理员的群直接添加机器人，个人使用完全够。

## 二、配置 `.env`

```ini
BOT_APP_ID=你的AppID
BOT_APP_SECRET=你的AppSecret

LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=sk-你的Key
LLM_MODEL=deepseek-chat
```

大模型兼容任何 OpenAI Chat Completions 协议，常见组合：

| 服务 | LLM_BASE_URL | LLM_MODEL |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| 智谱 | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| 本地 Ollama | `http://127.0.0.1:11434/v1` | `qwen2.5:7b` |

搜索（可选）：在 <https://app.tavily.com> 注册可获每月 1000 次免费额度，填 `TAVILY_API_KEY` 后自动优先使用；失败会自动回退必应，不填也能用。

## 三、把机器人加进群

1. 确认服务已启动且日志出现「机器人已上线」——**不在线时收不到任何消息**。
2. 手机 QQ 打开目标群 →「群设置」→「群机器人 / 机器人」→ 添加 → 搜索机器人名称。
3. 群主在添加时可点「设置权限」：
   - **接收全量消息**：开启后机器人能看到群内所有消息（可选，不开只收 @）
   - **主动推送消息**：需要定时播报时才勾选
4. 添加完成后，在群里 @ 它说话即可。

> 桌面端 QQ 没有添加群机器人的入口，必须用手机。
> 开启「接收全量消息」后，@ 消息也会走全量事件，本项目已做兼容（通过 `mentions` 判断）。

## 群内使用

| 场景 | 操作 |
| --- | --- |
| 聊天 | `@机器人 说话内容` |
| 私聊 | 直接点开机器人会话 |
| 强制搜索 | `@机器人 /search 关键词` |
| 帮助 | `@机器人 /help` |
| 清空记忆 | `@机器人 /clear` |
| 测活 | `@机器人 /ping` |

### 群内人设（群友可自助）

| 说/发什么 | 效果 |
| --- | --- |
| `@机器人 以后每句话结尾加个喵～` | 记住并立即生效 |
| `@机器人 /人设` | 查看本群已有要求 |
| `@机器人 /人设 说话别用感叹号` | 手动添加 |
| `@机器人 /人设 reset` | 清空（仅群主/管理员） |

规则按群保存在 `data/personas.json`：最多 5 条、30 秒冷却、同句去重、后说的优先级更高，重启不丢。

## 配置项

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BOT_APP_ID` / `BOT_APP_SECRET` | — | 必填，开放平台凭证 |
| `BOT_NAME` | `小Q` | 机器人名字，用于人设与日志 |
| `LLM_BASE_URL` | `https://api.deepseek.com/v1` | 大模型接口根地址 |
| `LLM_API_KEY` | — | 留空则进入回显模式（只复述） |
| `LLM_MODEL` | `deepseek-chat` | 模型名 |
| `LLM_SYSTEM_PROMPT` | 内置 | 人设提示词，`{name}` 会替换为机器人名 |
| `LLM_HISTORY_TURNS` | `10` | 每会话保留轮数 |
| `LLM_MAX_TOKENS` / `LLM_TEMPERATURE` | `800` / `0.8` | 生成参数 |
| `LLM_TIMEOUT_MS` | `50000` | 大模型超时 |
| `REPLY_MAX_CHARS` | `700` | 单条最大字数，超出分条 |
| `REPLY_MAX_CHUNKS` | `3` | 单次最多分几条（平台上限 5） |
| `REPLY_MIN_INTERVAL_MS` | `3200` | 同群最小发送间隔 |
| `GROUP_MESSAGE_POLICY` | `name` | 全量模式策略：`off` 只回 @ / `name` 叫名字也回 / `all` 每条都接 |
| `GROUP_REPLY_COOLDOWN_MS` | `30000` | 全量模式闲聊冷却（问句与被 @ 不受限） |
| `ALLOW_GROUPS` | 空 | 只响应指定群，逗号分隔 |
| `SEARCH_PROVIDER` | `auto` | `auto` / `bing` / `tavily` / `off` |
| `TAVILY_API_KEY` | 空 | Tavily 密钥，配置后优先使用 |
| `SEARCH_MAX_RESULTS` | `5` | 每次搜索取几条 |
| `SEARCH_RECENCY_FILTER` | `1` | 时效话题优先近 7 天结果 |
| `WEATHER_ENABLED` | `1` | 天气工具（Open-Meteo，免密钥） |
| `NEWS_ENABLED` / `NEWS_FEEDS` | `1` / IT之家 | 科技新闻来源，格式 `名字\|地址` |
| `PERSONA_ENABLED` | `1` | 群内改人设开关 |
| `PERSONA_MAX_RULES` / `PERSONA_COOLDOWN_MS` | `5` / `30000` | 规则条数上限与冷却 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `DATA_DIR` | `data` | 会话记忆与人设存放目录 |

## 常见问题

| 现象 / 错误码 | 原因与处理 |
| --- | --- |
| `100016 invalid appid or secret` | AppID / AppSecret 不对，核对「开发设置」 |
| `10004 机器人不存在` | AppID 填错，或与创建账号不一致 |
| `11244 AccessToken无效` | token 过期（会自动刷新）；反复出现检查系统时间 |
| 群里 @ 没反应，私聊正常 | 群权限没给，手机 QQ 群设置里重新添加并勾选权限 |
| `40034101 机器人非群成员` | 机器人不在群里，重新添加 |
| `40034005` / `40034128` | 超过被动回复 5 分钟 / 5 次限制 |
| `40054010 不允许发送URL` | 平台拦截链接，程序会自动去链接重试 |
| `40054007 消息长度超限` | 调小 `REPLY_MAX_CHARS` |
| `1100101 内容敏感` | 触发平台安全策略，调整回复内容或模型 |
| `4914 / 4915` | 机器人下架 / 封禁，只能人工处理 |

## 部署

**Windows 计划任务**

```powershell
schtasks /Create /TN "holyshit-qqbot" /TR "node <项目目录>\src\index.js" /SC ONSTART /RU "%USERNAME%" /RL HIGHEST /F
```

**PM2**

```bash
npm i -g pm2
pm2 start src/index.js --name qqbot --node-args="--env-file=.env"
pm2 save
pm2 startup
```

## 项目结构

```
src/
  index.js       启动入口、依赖装配、信号处理
  config.js      环境变量 → 配置对象 + 校验
  logger.js      带时区的分级日志
  token.js       access_token 获取与自动刷新（single-flight）
  api.js         OpenAPI v2 客户端
  gateway.js     WebSocket：Hello / 心跳 / Identify / Resume / 重连
  llm.js         OpenAI 兼容客户端（重试、超时、function calling）
  search.js      联网搜索（必应 HTML+RSS，Tavily，相关性重试）
  weather.js     实时天气（Open-Meteo）
  news.js        科技新闻聚合（RSS）
  rss.js         RSS / HTML 文本解析
  memory.js      会话记忆（滑动窗口 + TTL + 落盘）
  persona.js     群内人设规则（按群持久化）
  responder.js   分条、限速、msg_seq、发送错误归类
  commands.js    /help /search /人设 /clear /ping
  bot.js         事件分发、会话编排、去重、工具调用
scripts/
  check-config.mjs  配置自检（真连平台）
  selftest.mjs      离线端到端自测（mock 网关/接口/大模型）
  probe.mjs         接口连通性探测
  try-search.mjs    联网能力手动验证
```

## 开发

```bash
npm run dev        # 文件变更自动重启
npm run selftest   # 离线端到端自测，不消耗真实额度
npm run check      # 真连平台自检
```

自测覆盖：WebSocket 握手与 Resume、重复消息去重、分条与 `msg_seq`、私聊路由、群内人设、搜索/天气/新闻工具调用、Tavily 降级、消息发送鉴权。

## 安全与合规

- `AppSecret`、`API Key`、`data/` 下的会话记忆与人设均已加入 `.gitignore`，**不要提交**
- 机器人回复由大模型生成，请先在小范围试聊，确认内容符合平台规范
- 平台对机器人内容有审核，违规可能导致机器人与账号被封禁且不可解封
- 建议在开放平台设置 IP 白名单，并只把机器人加入自己管理的群

## License

[MIT](./LICENSE)
