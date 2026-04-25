# ASKGROK 中文说明

ASKGROK 是一个轻量级后端 API。它会打开一个真实浏览器，让使用者手动登录 [grok.com](https://grok.com)，然后通过浏览器把 prompt 发送给 Grok，等待回答完成后，把结果从后端 API 返回。

这个项目适合用在需要调用 Grok 但暂时没有官方 API，或者希望复用已登录浏览器会话的自动化场景。

## 功能

- 打开浏览器并让使用者手动登录 Grok
- 接收后端 API prompt，并自动输入到 Grok 聊天框
- 等待 Grok 回答完成
- 读取回答并返回给调用方
- 提供加密货币市场情绪分析端点
- 支持持久化浏览器登录状态

## 安装

```bash
npm install
npx playwright install chromium
npm start
```

默认服务地址：

```bash
http://localhost:3000
```

## 登录 Grok

第一次使用前，先打开浏览器登录：

```bash
curl -X POST http://localhost:3000/login
```

执行后会打开 Grok 浏览器窗口。请在窗口中完成登录。

ASKGROK 会把浏览器登录状态保存在 `.askgrok-profile/`，通常只需要登录一次。

## 通用提问

```bash
curl -X POST http://localhost:3000/ask \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"请用一句话介绍量子计算。"}'
```

返回示例：

```json
{
  "response": "..."
}
```

## 加密市场情绪分析

推荐主项目使用这个端点：

```bash
POST /sentiment/crypto
```

这个端点会让 Grok 自由使用网页搜索能力，综合 X/Twitter、新闻、市场评论、论坛、博客、价格背景等信息，输出结构化的加密市场情绪结果。

示例：

```bash
curl -X POST http://localhost:3000/sentiment/crypto \
  -H 'Content-Type: application/json' \
  -d '{
    "startUtc": "2022-05-20T00:00:00Z",
    "endUtc": "2022-05-20T01:00:00Z",
    "assets": ["BTC", "ETH", "LUNA", "UST"],
    "timeoutMs": 180000
  }'
```

请求参数：

```json
{
  "startUtc": "UTC 起始时间，ISO-8601 格式",
  "endUtc": "UTC 结束时间，ISO-8601 格式",
  "assets": ["资产代码，例如 BTC、ETH"],
  "timeoutMs": 180000,
  "includeRaw": false
}
```

返回示例：

```json
{
  "sentiment": {
    "timestamp_utc": "2022-05-20T00:00:00.000Z",
    "window_end_utc": "2022-05-20T01:00:00.000Z",
    "source": "ASKGROK_WEB",
    "data_scope": "web_research",
    "market": "crypto",
    "assets": ["BTC", "ETH", "LUNA", "UST"],
    "sentiment_score": -0.75,
    "sentiment_label": "fear",
    "confidence": 0.65,
    "social_volume_proxy": null,
    "bullish_intensity": 0.1,
    "bearish_intensity": 0.8,
    "fear_intensity": 0.85,
    "fomo_intensity": 0.05,
    "uncertainty_intensity": 0.6,
    "dominant_emotions": ["fear", "panic", "despair"],
    "dominant_topics": ["Terra collapse aftermath", "LUNA UST death spiral"],
    "notable_terms": ["crash", "capitulation", "depeg"],
    "evidence_sources": ["news", "market context", "social context"],
    "evidence_summary": "...",
    "sample_size_estimate": 50,
    "limitations": "..."
  }
}
```

`POST /sentiment/x-crypto` 仍然保留为兼容别名，但内部使用同一套 web research 情绪分析逻辑。

## API 列表

### `GET /health`

检查服务状态。

### `POST /login`

打开或复用浏览器窗口，并进入 Grok 登录页面。

### `POST /ask`

发送任意 prompt 给 Grok。

请求体：

```json
{
  "prompt": "你的问题",
  "timeoutMs": 120000
}
```

### `POST /sentiment/crypto`

执行加密市场情绪分析，返回结构化 JSON。

### `POST /close`

关闭浏览器会话。

## 情绪字段说明

- `sentiment_score`：范围为 `-1.0` 到 `1.0`
- `sentiment_label`：标准标签，例如 `extreme_fear`、`fear`、`cautious`、`neutral`、`optimistic`、`euphoria`、`unknown`
- `confidence`：Grok 对本次判断的置信度，范围 `0` 到 `1`
- `social_volume_proxy`：社群声量代理值；如果无法估计则为 `null`
- `bullish_intensity`：看多强度
- `bearish_intensity`：看空强度
- `fear_intensity`：恐惧强度
- `fomo_intensity`：FOMO 强度
- `uncertainty_intensity`：不确定性强度
- `evidence_sources`：Grok 使用的证据来源摘要
- `limitations`：本次分析的限制说明

## 注意事项

- 浏览器默认以 headed 模式运行，因为登录需要人工操作。
- 请使用你自己的 Grok 账号，并遵守 Grok 的服务条款和速率限制。
- Grok 网页 UI 如果改版，可能需要调整 `src/grokClient.js` 中的选择器。
- 这是浏览器自动化方案，不等同于官方 Grok API。
- `.askgrok-profile/` 包含本地浏览器登录资料，已经被 `.gitignore` 排除，不要上传到公开仓库。

## License

MIT
