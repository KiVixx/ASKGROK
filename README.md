# ASKGROK

ASKGROK is a small backend API that opens a real browser, lets the user log in to [grok.com](https://grok.com), sends prompts through the chat box, waits for the answer, and returns the response text from the backend.

## Setup

```bash
npm install
npx playwright install chromium
npm start
```

By default the API listens on `http://localhost:3000`.

## Login

Open a browser session for manual Grok login:

```bash
curl -X POST http://localhost:3000/login
```

A browser window will open at `https://grok.com`. Log in normally. ASKGROK stores the session in `.askgrok-profile/`, so you usually only need to do this once.

## Ask

```bash
curl -X POST http://localhost:3000/ask \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Explain quantum computing in one paragraph."}'
```

Response:

```json
{
  "response": "..."
}
```

## API

### `GET /health`

Returns server status.

### `POST /login`

Launches or reuses a headed browser window and navigates to Grok for manual login.

### `POST /ask`

Body:

```json
{
  "prompt": "Your question",
  "timeoutMs": 120000
}
```

`timeoutMs` is optional. Requests are handled one at a time so Grok conversations do not overlap.

### `POST /sentiment/crypto`

Runs the structured ASKGROK crypto sentiment prompt and returns normalized JSON for the ETL pipeline. Grok can use web/search context freely, including X/Twitter, news, market commentary, forums, blogs, and price context.

Body:

```json
{
  "startUtc": "2022-05-20T00:00:00Z",
  "endUtc": "2022-05-20T01:00:00Z",
  "assets": ["BTC", "ETH", "LUNA", "UST"],
  "timeoutMs": 180000,
  "includeRaw": false
}
```

Example:

```bash
curl -X POST http://localhost:3000/sentiment/crypto \
  -H 'Content-Type: application/json' \
  -d '{"startUtc":"2022-05-20T00:00:00Z","endUtc":"2022-05-20T01:00:00Z","assets":["BTC","ETH","LUNA","UST"],"timeoutMs":180000}'
```

`POST /sentiment/x-crypto` remains available as a backward-compatible alias.

Response:

```json
{
  "sentiment": {
    "timestamp_utc": "2022-05-20T00:00:00.000Z",
    "window_end_utc": "2022-05-20T01:00:00.000Z",
    "source": "ASKGROK_WEB",
    "data_scope": "web_research",
    "market": "crypto",
    "assets": ["BTC", "ETH", "LUNA", "UST"],
    "sentiment_score": -0.7,
    "sentiment_label": "fear",
    "confidence": 0.65,
    "social_volume_proxy": null,
    "bullish_intensity": 0.1,
    "bearish_intensity": 0.8,
    "fear_intensity": 0.85,
    "fomo_intensity": 0.05,
    "uncertainty_intensity": 0.75,
    "dominant_emotions": ["fear", "uncertainty"],
    "dominant_topics": ["Terra collapse", "Bitcoin drawdown"],
    "notable_terms": ["capitulation", "bear market"],
    "evidence_sources": ["X/Twitter", "market news", "price context"],
    "evidence_summary": "...",
    "sample_size_estimate": null,
    "limitations": "..."
  }
}
```

### `POST /close`

Closes the browser context.

## Notes

- The browser runs in headed mode because login requires user interaction.
- If Grok changes its web UI, selectors may need adjustment in `src/grokClient.js`.
- Use this with your own account and follow Grok's terms and rate limits.
