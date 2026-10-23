const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  middot: "·",
  bull: "·",
  deg: "°",
  times: "×",
  divide: "÷",
  copy: "©",
  reg: "®",
  trade: "™",
  laquo: "«",
  raquo: "»",
};

export function decodeEntities(text) {
  return String(text ?? "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, name) => {
    if (name[0] === "#") {
      const hex = name[1] === "x" || name[1] === "X";
      const code = Number.parseInt(hex ? name.slice(2) : name.slice(1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[name.toLowerCase()] ?? match;
  });
}

export function cleanXmlText(raw) {
  return decodeEntities(
    String(raw ?? "")
      .replace(/<!\[CDATA\[|\]\]>/g, "")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

export function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 把一段 HTML 片段转成纯文本（去脚本、去标签、解实体、压空白）。 */
export function stripHtml(html) {
  return decodeEntities(
    String(html ?? "")
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

const pick = (block, tag) => block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1];

/**
 * 解析 RSS 2.0 的 <item>。Atom（<entry>）不支持，够用即可。
 * @returns {{title: string, url: string, snippet: string, date: string}[]}
 */
export function parseRssItems(xml, limit = 20) {
  return [...String(xml ?? "").matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .slice(0, limit)
    .map((match) => {
      const block = match[1];
      return {
        title: cleanXmlText(pick(block, "title")),
        url: cleanXmlText(pick(block, "link")),
        snippet: cleanXmlText(pick(block, "description")).slice(0, 240),
        date: formatDate(cleanXmlText(pick(block, "pubDate"))),
      };
    })
    .filter((item) => item.title);
}
