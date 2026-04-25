import express from 'express';
import { GrokClient, GrokAutomationError } from './grokClient.js';
import {
  buildCryptoSentimentPrompt,
  normalizeAssets,
  normalizeSentimentResult,
  parseGrokJsonResponse,
  parseIsoDate
} from './sentimentPrompt.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const grok = new GrokClient({
  headless: process.env.HEADLESS === 'true',
  profileDir: process.env.GROK_PROFILE_DIR || '.askgrok-profile',
  url: process.env.GROK_URL || 'https://grok.com'
});

app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'ASKGROK',
    browserOpen: grok.isOpen()
  });
});

app.post('/login', async (_req, res, next) => {
  try {
    await grok.openForLogin();
    res.json({
      ok: true,
      message: 'Browser opened. Log in to Grok in the browser window, then call POST /ask.'
    });
  } catch (error) {
    next(error);
  }
});

app.post('/ask', async (req, res, next) => {
  try {
    const { prompt, timeoutMs } = req.body || {};

    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      res.status(400).json({ error: 'Request body must include a non-empty string field: prompt.' });
      return;
    }

    const response = await grok.ask(prompt, {
      timeoutMs: Number.isFinite(timeoutMs) ? Number(timeoutMs) : undefined
    });

    res.json({ response });
  } catch (error) {
    next(error);
  }
});

async function handleCryptoSentiment(req, res, next) {
  try {
    const { startUtc, endUtc, assets: requestedAssets, timeoutMs, includeRaw = false } = req.body || {};
    const start = parseIsoDate(startUtc, 'startUtc');
    const end = parseIsoDate(endUtc, 'endUtc');
    const assets = normalizeAssets(requestedAssets);

    if (end <= start) {
      res.status(400).json({ error: 'endUtc must be after startUtc.' });
      return;
    }

    const prompt = buildCryptoSentimentPrompt({
      startUtc: start.toISOString(),
      endUtc: end.toISOString(),
      assets
    });

    const rawResponse = await grok.ask(prompt, {
      timeoutMs: Number.isFinite(timeoutMs) ? Number(timeoutMs) : undefined
    });
    let parsed;
    try {
      parsed = parseGrokJsonResponse(rawResponse);
    } catch (error) {
      if (includeRaw) {
        res.status(502).json({
          error: `Unable to parse Grok sentiment JSON: ${error.message}`,
          rawResponse
        });
        return;
      }

      throw error;
    }

    const sentiment = normalizeSentimentResult(parsed, {
      startUtc: start.toISOString(),
      endUtc: end.toISOString(),
      assets,
      source: 'ASKGROK_WEB'
    });

    res.json(includeRaw ? { sentiment, rawResponse } : { sentiment });
  } catch (error) {
    if (error instanceof SyntaxError || error.message?.includes('JSON')) {
      next(new GrokAutomationError(`Unable to parse Grok sentiment JSON: ${error.message}`, 502));
      return;
    }

    if (error.message?.includes('startUtc') || error.message?.includes('endUtc') || error.message?.includes('assets')) {
      res.status(400).json({ error: error.message });
      return;
    }

    next(error);
  }
}

app.post('/sentiment/crypto', handleCryptoSentiment);
app.post('/sentiment/x-crypto', handleCryptoSentiment);

app.post('/close', async (_req, res, next) => {
  try {
    await grok.close();
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  const status = error instanceof GrokAutomationError ? error.statusCode : 500;
  res.status(status).json({
    error: error.message || 'Unexpected server error'
  });
});

process.on('SIGINT', async () => {
  await grok.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await grok.close();
  process.exit(0);
});

app.listen(port, () => {
  console.log(`ASKGROK API listening on http://localhost:${port}`);
});
