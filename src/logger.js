const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const pad = (value, width = 2) => String(value).padStart(width, "0");

/** 本地时区带偏移的时间戳，例如 2026-10-23T10:29:24.123+08:00 */
export function timestamp(date = new Date()) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function format(value) {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function build(threshold, scope) {
  const write = (level, args) => {
    if (LEVELS[level] < threshold) return;
    const prefix = `${timestamp()} ${level.toUpperCase().padEnd(5)} ${scope ? `[${scope}] ` : ""}`;
    const line = prefix + args.map(format).join(" ");
    // 统一写 stdout：Windows PowerShell 下把中文错误写到 stderr 会被包成
    // NativeCommandError，反而看不清内容。
    console.log(line);
  };

  return {
    debug: (...args) => write("debug", args),
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
    child: (name) => build(threshold, scope ? `${scope}/${name}` : name),
  };
}

export function createLogger(level = "info") {
  return build(LEVELS[level] ?? LEVELS.info, "");
}
