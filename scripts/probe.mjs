const targets = [
  ["POST", "https://api.bot.qq.com/app/getAppAccessToken", { appId: "123456", clientSecret: "x" }],
  ["GET", "https://api.bot.qq.com/gateway/bot", null],
  ["GET", "https://api.bot.qq.com/gateway", null],
  ["GET", "https://api.bot.qq.com/users/@me", null],
];

for (const [method, url, body] of targets) {
  try {
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: "QQBot dummy",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    console.log(`${method} ${url} -> ${res.status} ${text.slice(0, 300)}`);
  } catch (err) {
    console.log(`${method} ${url} -> ERROR ${err.message}`);
  }
}
