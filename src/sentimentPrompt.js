const DEFAULT_ASSETS = ['BTC', 'ETH', 'LUNA', 'UST', 'general crypto market'];
const DEFAULT_KEYWORDS = [
  'crypto',
  'bitcoin',
  'BTC',
  'ETH',
  'altcoins',
  'LUNA',
  'UST',
  'DeFi',
  'bear market',
  'crash',
  'pump',
  'dump',
  'bottom',
  'capitulation'
];

const LABELS = new Set([
  'extreme_fear',
  'fear',
  'cautious',
  'neutral',
  'optimistic',
  'euphoria',
  'unknown'
]);

export function buildCryptoSentimentPrompt({
  startUtc,
  endUtc,
  assets = DEFAULT_ASSETS,
  keywords = DEFAULT_KEYWORDS
}) {
  return `Return JSON only. No Markdown.

Role: financial crypto sentiment research labeler.
Window UTC: ${startUtc} to ${endUtc}
Assets: ${assets.join(', ')}
Keywords: ${keywords.join(', ')}

Use Grok's web/search ability freely. You may use X/Twitter posts, news, market commentary, exchange updates, crypto forums, blogs, and price context to infer the market's emotional state.

Rules:
- Focus on group sentiment and risk appetite, not just price direction.
- Price action can support the interpretation, but do not treat price movement alone as sentiment.
- Prefer evidence close to the UTC window. If exact hourly evidence is weak, use nearby same-day context and lower confidence.
- If evidence is insufficient, use sentiment_score:null and sentiment_label:"unknown".

Scores: sentiment_score -1..1; intensities/confidence 0..1; unknown counts null.

Schema:
{
  "timestamp_utc": "${startUtc}",
  "window_end_utc": "${endUtc}",
  "source": "ASKGROK_WEB",
  "data_scope": "web_research",
  "market": "crypto",
  "assets": ${JSON.stringify(assets)},
  "sentiment_score": null,
  "sentiment_label": "unknown",
  "confidence": 0.0,
  "social_volume_proxy": null,
  "bullish_intensity": 0.0,
  "bearish_intensity": 0.0,
  "fear_intensity": 0.0,
  "fomo_intensity": 0.0,
  "uncertainty_intensity": 0.0,
  "dominant_emotions": [],
  "dominant_topics": [],
  "notable_terms": [],
  "evidence_sources": [],
  "evidence_summary": "",
  "sample_size_estimate": null,
  "limitations": ""
}`;
}

export const buildXCryptoSentimentPrompt = buildCryptoSentimentPrompt;

export function parseGrokJsonResponse(text) {
  const cleaned = text
    .replace(/^思考了\s*\d+\s*s?\s*/i, '')
    .replace(/^thought for\s*\d+\s*s?\s*/i, '')
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();

  const jsonText = extractBalancedJson(cleaned);
  if (!jsonText) {
    throw new Error('Grok did not return a JSON object or array.');
  }

  return JSON.parse(jsonText);
}

export function normalizeSentimentResult(result, { startUtc, endUtc, assets, source = 'ASKGROK_WEB' }) {
  const normalized = {
    timestamp_utc: result.timestamp_utc || startUtc,
    window_end_utc: result.window_end_utc || endUtc,
    source,
    data_scope: typeof result.data_scope === 'string' ? result.data_scope : 'web_research',
    market: 'crypto',
    assets: Array.isArray(result.assets) ? result.assets : assets,
    sentiment_score: nullableClampedNumber(result.sentiment_score, -1, 1),
    sentiment_label: normalizeLabel(result.sentiment_label, result.sentiment_score),
    confidence: clampedNumber(result.confidence, 0, 1, 0),
    social_volume_proxy: nullableNonNegativeNumber(result.social_volume_proxy),
    bullish_intensity: clampedNumber(result.bullish_intensity, 0, 1, 0),
    bearish_intensity: clampedNumber(result.bearish_intensity, 0, 1, 0),
    fear_intensity: clampedNumber(result.fear_intensity, 0, 1, 0),
    fomo_intensity: clampedNumber(result.fomo_intensity, 0, 1, 0),
    uncertainty_intensity: clampedNumber(result.uncertainty_intensity, 0, 1, 0),
    dominant_emotions: stringArray(result.dominant_emotions),
    dominant_topics: stringArray(result.dominant_topics),
    notable_terms: stringArray(result.notable_terms),
    evidence_sources: stringArray(result.evidence_sources),
    evidence_summary: typeof result.evidence_summary === 'string' ? result.evidence_summary : '',
    sample_size_estimate: nullableNonNegativeNumber(result.sample_size_estimate),
    limitations: typeof result.limitations === 'string' ? result.limitations : ''
  };

  if (normalized.sentiment_score === null) {
    normalized.sentiment_label = 'unknown';
  }

  return normalized;
}

export function parseIsoDate(value, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty ISO-8601 UTC string.`);
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} must be a valid ISO-8601 UTC string.`);
  }

  return date;
}

export function normalizeAssets(value) {
  if (value === undefined) {
    return DEFAULT_ASSETS;
  }

  if (!Array.isArray(value)) {
    throw new Error('assets must be an array of strings.');
  }

  const assets = value
    .filter((asset) => typeof asset === 'string')
    .map((asset) => asset.trim())
    .filter(Boolean);

  if (!assets.length) {
    throw new Error('assets must contain at least one non-empty string.');
  }

  return assets;
}

function normalizeLabel(value, score) {
  if (typeof value === 'string') {
    const label = value.trim().toLowerCase();
    if (LABELS.has(label)) {
      return label;
    }

    if (['panic', 'capitulation', 'extreme_bearish', 'extremely_bearish'].includes(label)) {
      return 'extreme_fear';
    }

    if (['bearish', 'strongly_bearish', 'risk_off', 'negative'].includes(label)) {
      return 'fear';
    }

    if (['mixed', 'uncertain', 'cautious_bearish'].includes(label)) {
      return 'cautious';
    }

    if (['bullish', 'positive', 'risk_on'].includes(label)) {
      return 'optimistic';
    }

    if (['strongly_bullish', 'fomo', 'mania'].includes(label)) {
      return 'euphoria';
    }
  }

  const numericScore = Number(score);
  if (!Number.isFinite(numericScore)) {
    return 'unknown';
  }

  if (numericScore <= -0.8) return 'extreme_fear';
  if (numericScore <= -0.35) return 'fear';
  if (numericScore < -0.1) return 'cautious';
  if (numericScore <= 0.1) return 'neutral';
  if (numericScore < 0.75) return 'optimistic';
  return 'euphoria';
}

function extractBalancedJson(text) {
  const objectStart = text.indexOf('{');
  const arrayStart = text.indexOf('[');
  const start = [objectStart, arrayStart].filter((index) => index >= 0).sort((a, b) => a - b)[0];

  if (start === undefined) {
    return '';
  }

  const opening = text[start];
  const closing = opening === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === opening) {
      depth += 1;
    } else if (char === closing) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return '';
}

function clampedNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

function nullableClampedNumber(value, min, max) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return clampedNumber(value, min, max, null);
}

function nullableNonNegativeNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const number = Number(value);
  if (!Number.isFinite(number)) {
    return null;
  }

  return Math.max(0, number);
}

function stringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}
