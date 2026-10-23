const WMO = {
  0: "晴",
  1: "晴间多云",
  2: "多云",
  3: "阴",
  45: "雾",
  48: "雾凇",
  51: "小毛雨",
  53: "毛毛雨",
  55: "大毛雨",
  56: "冻毛雨",
  57: "强冻毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  66: "冻雨",
  67: "强冻雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  77: "雪粒",
  80: "阵雨",
  81: "强阵雨",
  82: "暴雨",
  85: "阵雪",
  86: "强阵雪",
  95: "雷阵雨",
  96: "雷阵雨伴冰雹",
  99: "强雷阵雨伴冰雹",
};

export class WeatherError extends Error {
  constructor(message) {
    super(message);
    this.name = "WeatherError";
  }
}

/** 免密钥实时天气：Open-Meteo 地理编码 + 预报（中文城市名可直接用）。 */
export class WeatherClient {
  constructor({ config, logger }) {
    this.cfg = config.weather;
    this.logger = logger;
  }

  get enabled() {
    return this.cfg.enabled;
  }

  /**
   * @param {string} city
   * @returns {Promise<string>} 给模型看的纯文本天气摘要
   */
  async describe(city) {
    const name = String(city ?? "").trim().slice(0, 40);
    if (!name) throw new WeatherError("城市名为空");

    const startedAt = Date.now();
    const geoUrl =
      `${this.cfg.geoEndpoint}?name=${encodeURIComponent(name)}` +
      "&count=1&language=zh&format=json";
    const geo = await this.#json(geoUrl, "地理编码");
    const place = geo?.results?.[0];
    if (!place) throw new WeatherError(`没找到城市「${name}」，换个写法试试（如“杭州”）`);

    const forecastUrl =
      `${this.cfg.forecastEndpoint}?latitude=${place.latitude}&longitude=${place.longitude}` +
      "&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m" +
      "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
      "&timezone=Asia%2FShanghai&forecast_days=2";
    const forecast = await this.#json(forecastUrl, "天气数据");

    const current = forecast?.current ?? {};
    const daily = forecast?.daily ?? {};
    const label = WMO[current.weather_code] ?? "未知";
    const placeText = [place.name, place.admin1, place.country].filter(Boolean).join(" ");

    const lines = [
      `${placeText}实时天气：`,
      `现在：${label}，${current.temperature_2m}℃（体感 ${current.apparent_temperature}℃），` +
        `湿度 ${current.relative_humidity_2m}%，风速 ${current.wind_speed_10m} km/h`,
    ];

    const dates = daily.time ?? [];
    for (let i = 0; i < Math.min(2, dates.length); i += 1) {
      const dayLabel = i === 0 ? "今天" : "明天";
      lines.push(
        `${dayLabel}（${dates[i]}）：${daily.temperature_2m_min?.[i]} ~ ${daily.temperature_2m_max?.[i]}℃，` +
          `降水概率 ${daily.precipitation_probability_max?.[i] ?? 0}%`,
      );
    }

    this.logger.info(`天气查询「${name}」成功（${Date.now() - startedAt}ms）`);
    return lines.join("\n");
  }

  async #json(url, label) {
    let response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(this.cfg.timeoutMs) });
    } catch (error) {
      throw new WeatherError(`${label}请求失败：${error.message}`);
    }
    if (!response.ok) throw new WeatherError(`${label}接口返回 HTTP ${response.status}`);
    const data = await response.json().catch(() => null);
    if (!data) throw new WeatherError(`${label}返回内容无法解析`);
    return data;
  }
}

export const WEATHER_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "查询某个城市的实时天气和今明两天预报。用户问天气、气温、下雨、穿什么时调用。",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "城市名，中文即可，例如「北京」「杭州」" },
      },
      required: ["city"],
    },
  },
};

export const WEATHER_SYSTEM_HINT =
  "问天气时请调用 get_weather（传城市名），不要用 web_search 查天气；如果用户没说城市，就问一句是哪个城市。";
