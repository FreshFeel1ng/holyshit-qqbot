const SIMPLE_COMMANDS = [
  { name: "help", pattern: /^\/?(help|帮助|菜单|功能)$/i },
  { name: "clear", pattern: /^\/?(clear|reset|清空|清空上下文|清除记忆|遗忘)$/i },
  { name: "ping", pattern: /^\/?(ping|在不在|活着吗)$/i },
];

const SEARCH_COMMAND = /^\/?(?:search|搜索|搜一下|查一下)\s*([\s\S]*)$/i;
const PERSONA_COMMAND = /^\/?(?:persona|人设)\s*([\s\S]*)$/i;

/**
 * 识别本地命令。
 * @returns {{name: 'help'|'clear'|'ping'|'search'|'persona', args: string} | null}
 */
export function parseCommand(text) {
  const value = String(text ?? "").trim();
  if (!value || value.length > 500) return null;

  const persona = value.match(PERSONA_COMMAND);
  if (persona) return { name: "persona", args: (persona[1] ?? "").trim() };

  const search = value.match(SEARCH_COMMAND);
  if (search) return { name: "search", args: (search[1] ?? "").trim() };

  if (value.length > 20) return null;
  for (const { name, pattern } of SIMPLE_COMMANDS) {
    if (pattern.test(value)) return { name, args: "" };
  }
  return null;
}

export function helpText(botName) {
  return [
    `我是「${botName}」，一个群聊 AI 机器人～`,
    "",
    "· 直接在群里 @我 说话，就能跟我聊",
    "· 也可以私聊我，聊天气、写东西、问问题都行",
    "· 需要最新信息时我会自己联网搜",
    "",
    "可用命令：",
    "/help   显示这份说明",
    "/search 关键词   强制联网搜索后回答",
    "/人设   查看本群的人设规则",
    "/人设 reset   清空（群主/管理员）",
    "/clear  清空当前对话记忆，重新开始",
    "/ping   检查我是否在线",
    "",
    "也可以直接说「以后说话结尾加喵～」这类要求，我会记住并照做。",
  ].join("\n");
}

export function pingText(startedAt = Date.now()) {
  return `pong～ 我在线（本地已运行 ${Math.floor((Date.now() - startedAt) / 1000)}s）`;
}
