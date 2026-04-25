import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const DEFAULT_TIMEOUT_MS = 120_000;
const RESPONSE_STABLE_MS = 2_500;

export class GrokAutomationError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.name = 'GrokAutomationError';
    this.statusCode = statusCode;
  }
}

export class GrokClient {
  constructor({ headless = false, profileDir = '.askgrok-profile', url = 'https://grok.com' } = {}) {
    this.headless = headless;
    this.profileDir = path.resolve(projectRoot, profileDir);
    this.url = url;
    this.context = null;
    this.page = null;
    this.queue = Promise.resolve();
  }

  isOpen() {
    return Boolean(this.context && this.page && !this.page.isClosed());
  }

  async openForLogin() {
    const page = await this.ensurePage();
    await page.goto(this.url, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
  }

  async ask(prompt, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    return this.enqueue(async () => {
      const page = await this.ensurePage();
      await page.bringToFront();
      await page.goto(this.url, { waitUntil: 'domcontentloaded' });

      await this.waitForChatInput(page, timeoutMs);

      const beforeSnapshot = await this.readConversationSnapshot(page);
      await this.fillPrompt(page, prompt, timeoutMs);
      await this.submitPrompt(page, timeoutMs, prompt);

      const response = await this.waitForNewResponse(page, beforeSnapshot, timeoutMs, prompt);
      if (!response) {
        throw new GrokAutomationError('Grok response was empty or could not be read.', 502);
      }

      return response;
    });
  }

  async close() {
    if (this.context) {
      await this.context.close();
    }
    this.context = null;
    this.page = null;
  }

  enqueue(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  async ensurePage() {
    if (this.isOpen()) {
      return this.page;
    }

    this.context = await chromium.launchPersistentContext(this.profileDir, {
      headless: this.headless,
      viewport: { width: 1440, height: 1000 },
      args: ['--disable-blink-features=AutomationControlled']
    });

    this.page = this.context.pages()[0] || await this.context.newPage();
    this.page.setDefaultTimeout(30_000);
    return this.page;
  }

  async waitForChatInput(page, timeoutMs) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (await this.findInputHandle(page)) {
        return;
      }

      if (await this.looksLoggedOut(page)) {
        throw new GrokAutomationError('Grok is asking for login. Use POST /login and finish logging in first.', 401);
      }

      await page.waitForTimeout(500);
    }

    throw new GrokAutomationError('Timed out waiting for the Grok chat input.', 504);
  }

  async fillPrompt(page, prompt, timeoutMs) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const handle = await this.findInputHandle(page);
      if (handle) {
        await handle.click();
        try {
          await handle.fill(prompt, { timeout: 5_000 });
          await page.waitForTimeout(300);
          return;
        } catch {
          await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
          await page.keyboard.insertText(prompt);
          await page.waitForTimeout(300);
          return;
        }
      }

      await page.waitForTimeout(300);
    }

    throw new GrokAutomationError('Unable to focus the Grok chat input.', 504);
  }

  async submitPrompt(page, timeoutMs, prompt = '') {
    const input = await this.findInputHandle(page);
    if (!input) {
      throw new GrokAutomationError('Unable to submit prompt because the chat input disappeared.', 502);
    }

    await input.press('Enter', { timeout: timeoutMs });
    await page.waitForTimeout(1_000);

    if (await this.isGenerating(page)) {
      return;
    }

    const currentInput = normalizeText(await this.readInputText(page));
    if (prompt && !currentInput.includes(normalizeText(prompt).slice(0, 120))) {
      return;
    }

    const sendButton = await this.findSendButton(page);
    if (sendButton) {
      await sendButton.click();
      await page.waitForTimeout(1_000);
      return;
    }

    throw new GrokAutomationError('Unable to submit prompt. The chat input still appears to contain the prompt.', 502);
  }

  async waitForNewResponse(page, beforeSnapshot, timeoutMs, submittedPrompt = '') {
    const deadline = Date.now() + timeoutMs;
    let lastText = '';
    let lastChangedAt = Date.now();

    while (Date.now() < deadline) {
      const afterSnapshot = await this.readConversationSnapshot(page);
      const candidate = this.extractNewAssistantText(beforeSnapshot, afterSnapshot, submittedPrompt);

      if (candidate && candidate !== lastText) {
        lastText = candidate;
        lastChangedAt = Date.now();
      }

      if (lastText && Date.now() - lastChangedAt >= RESPONSE_STABLE_MS && !(await this.isGenerating(page))) {
        return cleanupResponse(lastText);
      }

      await page.waitForTimeout(600);
    }

    if (lastText) {
      return cleanupResponse(lastText);
    }

    throw new GrokAutomationError('Timed out waiting for Grok response.', 504);
  }

  extractNewAssistantText(beforeSnapshot, afterSnapshot, submittedPrompt = '') {
    const before = new Set(beforeSnapshot.blocks.map((block) => normalizeText(block)));
    const normalizedPrompt = normalizeText(submittedPrompt);
    const newBlocks = afterSnapshot.blocks
      .map((block) => cleanupResponse(block))
      .filter((block) => {
        const normalizedBlock = normalizeText(block);
        return block &&
          !before.has(normalizedBlock) &&
          !looksLikeSubmittedPrompt(normalizedBlock, normalizedPrompt);
      });

    const withoutPromptEcho = newBlocks.filter((block) => !afterSnapshot.lastPrompt || normalizeText(block) !== normalizeText(afterSnapshot.lastPrompt));
    const candidates = withoutPromptEcho.length ? withoutPromptEcho : newBlocks;
    const jsonCandidate = candidates
      .filter((block) => hasBalancedJson(block))
      .reduce((best, block) => (block.length >= best.length ? block : best), '');

    if (jsonCandidate) {
      return jsonCandidate;
    }

    return candidates.reduce((best, block) => (block.length >= best.length ? block : best), '');
  }

  async readConversationSnapshot(page) {
    return page.evaluate(() => {
      const ignoredTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'BUTTON', 'NAV', 'HEADER', 'FOOTER']);
      const visible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const clean = (text) => text.replace(/\s+/g, ' ').trim();
      const selectors = [
        '[data-message-author-role="assistant"]',
        '[data-testid*="message" i]',
        '[data-testid*="conversation" i]',
        '[class*="message" i]',
        '[class*="response" i]',
        '[class*="markdown" i]',
        'article',
        'main [dir="auto"]',
        'main p',
        'main li',
        'main pre'
      ];

      const seen = new Set();
      const blocks = [];

      for (const selector of selectors) {
        for (const element of document.querySelectorAll(selector)) {
          if (ignoredTags.has(element.tagName) || !visible(element)) {
            continue;
          }

          if (element.closest('textarea, input, [contenteditable="true"], [role="textbox"]')) {
            continue;
          }

          const text = clean(element.innerText || element.textContent || '');
          if (text.length < 2 || seen.has(text)) {
            continue;
          }

          seen.add(text);
          blocks.push(text);
        }
      }

      const editable = document.querySelector('textarea, [contenteditable="true"], [role="textbox"]');
      return {
        blocks,
        lastPrompt: clean(editable?.innerText || editable?.value || '')
      };
    });
  }

  async findInputHandle(page) {
    const locators = [
      page.getByRole('textbox').last(),
      page.locator('textarea[placeholder*="Ask" i]').last(),
      page.locator('textarea').last(),
      page.locator('[contenteditable="true"]').last(),
      page.locator('[role="textbox"]').last()
    ];

    for (const locator of locators) {
      try {
        if (await locator.count()) {
          const candidate = locator.first();
          if (await candidate.isVisible()) {
            return candidate;
          }
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  async findSendButton(page) {
    const locators = [
      page.getByRole('button', { name: /send|submit|arrow|發送|发送/i }).last(),
      page.locator('button[aria-label*="send" i]').last(),
      page.locator('button[type="submit"]').last()
    ];

    for (const locator of locators) {
      try {
        if (await locator.count()) {
          const candidate = locator.first();
          if (await candidate.isVisible() && await candidate.isEnabled()) {
            return candidate;
          }
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  async isGenerating(page) {
    return page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      return text.includes('stop generating') ||
        text.includes('generating') ||
        text.includes('停止生成') ||
        Boolean(document.querySelector('[aria-label*="stop" i], [data-testid*="stop" i]'));
    });
  }

  async looksLoggedOut(page) {
    return page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      const hasLoginText = text.includes('log in') || text.includes('sign in') || text.includes('登入') || text.includes('登录');
      const hasInput = Boolean(document.querySelector('textarea, [contenteditable="true"], [role="textbox"]'));
      return hasLoginText && !hasInput;
    });
  }

  async readInputText(page) {
    return page.evaluate(() => {
      const editable = document.querySelector('textarea, [contenteditable="true"], [role="textbox"]');
      if (!editable) {
        return '';
      }

      return editable.value || editable.innerText || editable.textContent || '';
    });
  }
}

function cleanupResponse(text) {
  return text
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function normalizeText(text) {
  return cleanupResponse(text).replace(/\s+/g, ' ').toLowerCase();
}

function looksLikeSubmittedPrompt(normalizedBlock, normalizedPrompt) {
  if (!normalizedBlock || !normalizedPrompt) {
    return false;
  }

  const promptPrefix = normalizedPrompt.slice(0, Math.min(240, normalizedPrompt.length));
  const blockPrefix = normalizedBlock.slice(0, Math.min(240, normalizedBlock.length));

  return normalizedBlock === normalizedPrompt ||
    normalizedBlock.includes(promptPrefix) ||
    normalizedPrompt.includes(blockPrefix) ||
    normalizedBlock.includes('focus on group sentiment and risk appetite') ||
    normalizedBlock.includes('scores sentiment_score -1..1') ||
    (
      normalizedBlock.includes('return json only') &&
      normalizedBlock.includes('schema') &&
      normalizedBlock.includes('sentiment_score')
    );
}

function hasBalancedJson(text) {
  const objectStart = text.indexOf('{');
  const arrayStart = text.indexOf('[');
  const start = [objectStart, arrayStart].filter((index) => index >= 0).sort((a, b) => a - b)[0];

  if (start === undefined) {
    return false;
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

    if (inString && char === '\\') {
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
        return true;
      }
    }
  }

  return false;
}
