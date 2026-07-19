import path from 'node:path';
import dotenv from 'dotenv';
import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import Groq from 'groq-sdk';
import { validateMessages, ChatMessage } from './validation';
import { connectMongo } from './db';
import { conversationsRouter } from './routes/conversations';

// Anchor to this file's directory (not process.cwd()) so the key loads
// correctly regardless of which directory the process was started from.
const envPath = path.resolve(__dirname, '..', '.env');
const dotenvResult = dotenv.config({ path: envPath });

if (dotenvResult.error) {
  console.warn(`[startup] Could not read .env at ${envPath}: ${dotenvResult.error.message}`);
} else {
  console.log(`[startup] Loaded environment variables from ${envPath}`);
}
console.log(`[startup] GROQ_API_KEY present: ${Boolean(process.env['GROQ_API_KEY'])}`);
console.log(`[startup] MONGODB_URI present: ${Boolean(process.env['MONGODB_URI'])}`);

if (!process.env['GROQ_API_KEY']) {
  throw new Error(
    `GROQ_API_KEY is not set (looked for it in ${envPath}). ` +
      'Copy server/.env.example to server/.env and fill in your key.',
  );
}

connectMongo(process.env['MONGODB_URI']);

const groq = new Groq({ apiKey: process.env['GROQ_API_KEY'] });

const MODEL_GENERAL = 'llama-3.3-70b-versatile';
// GPT OSS 120B is Groq's largest general-purpose production model (vs. 70B
// for the general mode) and has built-in reasoning, trading a bit of speed
// for more thorough answers.
const MODEL_SMART = 'openai/gpt-oss-120b';
// Neither text model above understands images, so any request containing
// image content is routed to this vision-capable model instead, regardless
// of the selected mode — see hasImageContent()/resolve below. (Llama 4
// Scout/Maverick, the models usually cited for Groq vision, 404 on this
// account — confirmed via groq.models.list() — so this is the vision model
// actually available and working here.)
const MODEL_VISION = 'qwen/qwen3.6-27b';

// "teenager" (Insight) and "smart" (Deeper Insight) both use the larger
// model — they differ only in system prompt (and reasoning effort), not model.
function resolveModel(mode: unknown): string {
  return mode === 'smart' || mode === 'teenager' ? MODEL_SMART : MODEL_GENERAL;
}

const SYSTEM_PROMPT_GENERAL =
  'You are the helpful conversational AI assistant embedded in Strong Type, ' +
  'a site for strengthening and improving written text. Explain things simply, ' +
  'the way you would to a 12-year-old: short sentences, easy everyday words, ' +
  'no jargon. Keep replies short — a few sentences at most, unless the user ' +
  'clearly asks for more detail. This is "Explore" mode, for a child ' +
  'audience — keep your tone warm and encouraging. Do not include violence, ' +
  'sexual content, drugs/alcohol, profanity, or other mature or frightening ' +
  'subject matter. If the question touches on something not appropriate ' +
  'for a child, gently steer to a safe, age-appropriate angle instead of ' +
  'engaging with the mature part.';

// Insight mode is the middle tier: more explanation than General, but
// explicitly capped to a single short paragraph and no structure (headings/
// bullets), so it can't drift into Deeper Insight's territory. Told to write
// tightly so that cap doesn't come at the cost of substance.
const SYSTEM_PROMPT_TEENAGER =
  'You are the helpful conversational AI assistant embedded in Strong Type, ' +
  'a site for strengthening and improving written text. Explain things clearly, ' +
  'at a level a teenager would follow: plain language, but you can use more ' +
  'developed vocabulary and sentence structure than you would for a young ' +
  'child. This is "Insight" mode — give a moderately detailed answer: a bit ' +
  'more explanation and reasoning than a one- or two-sentence reply, but ' +
  'keep the whole answer to a single short paragraph. Do not use headings, ' +
  'bullet lists, or multiple sections. Write tightly: no filler phrases, no ' +
  'restating the question, no saying the same point twice in different ' +
  'words — every sentence should add something new. Keep the full amount of ' +
  'information, just say it more economically. This mode is for a teenage ' +
  'audience — avoid explicit sexual content, graphic violence, drug-use ' +
  'instructions, or other adult material. You can acknowledge that mature ' +
  'topics exist and discuss them at a general, non-graphic level when ' +
  'directly relevant, but do not go into explicit detail.';

// Deeper Insight is the most thorough tier this app offers: the largest
// model, highest reasoning effort, and explicitly told to go deep and use
// structure where it helps, not to hold back for brevity — but "thorough"
// means covering more ground, not restating the same ground in more words.
const SYSTEM_PROMPT_SMART =
  'You are the helpful conversational AI assistant embedded in Strong Type, ' +
  'a site for strengthening and improving written text. This is "Deeper ' +
  'Insight" mode, for an adult audience and the most thorough option this ' +
  'app offers — give a comprehensive, well-structured answer that covers ' +
  'the relevant details, reasoning, and useful context in full rather than ' +
  'a quick summary, using headings or a short list if that makes it ' +
  'clearer. You do not need to simplify vocabulary or avoid jargon — write ' +
  'at a full adult level, and be technical or direct where that serves the ' +
  'answer. There are no additional content restrictions beyond normal ' +
  'safety limits: mature or complex topics can be discussed in full depth ' +
  'when relevant. Keep every bit of that depth — cover the same range of ' +
  'sub-topics you otherwise would; do not drop a topic or example just to ' +
  'save space. Instead write tightly: no filler phrases, no throat-clearing ' +
  'intros, and no restating a point you already made (including in a ' +
  'closing "recap" or "bottom line" section — do not add one). Each ' +
  'sentence should carry new information, so the same substance takes up ' +
  'less text.';

function resolveSystemPrompt(mode: unknown): string {
  if (mode === 'smart') return SYSTEM_PROMPT_SMART;
  if (mode === 'teenager') return SYSTEM_PROMPT_TEENAGER;
  return SYSTEM_PROMPT_GENERAL;
}

// Deeper Insight reasons harder than Insight — same model, different token
// budget for reasoning — which also helps keep the two visibly distinct.
// Only meaningful for MODEL_SMART; callers must not send it alongside the
// vision model, which likely doesn't support the param.
function resolveReasoningEffort(mode: unknown): 'high' | 'medium' | undefined {
  if (mode === 'smart') return 'high';
  if (mode === 'teenager') return 'medium';
  return undefined;
}

// In-memory only — resets on server restart, and isn't shared across
// multiple server instances. Fine for this single-process dev/small-scale
// setup; a real multi-instance deployment would need a shared store.
interface TokenStatus {
  remainingTokens: number | null;
  limitTokens: number | null;
  resetTokens: string | null;
  // Parsed from resetTokens (a duration like "585ms"/"7.66s"/"1m26.4s") into
  // plain seconds, so the frontend can drive a live countdown against
  // updatedAt instead of re-parsing Groq's ad-hoc duration format itself.
  resetTokensSeconds: number | null;
  model: string | null;
  updatedAt: string | null;
}
let latestTokenStatus: TokenStatus = {
  remainingTokens: null,
  limitTokens: null,
  resetTokens: null,
  resetTokensSeconds: null,
  model: null,
  updatedAt: null,
};

// Groq's x-ratelimit-reset-* headers use a compact duration format —
// some combination of "<n>h", "<n>m", "<n>s" (fractional seconds allowed),
// "<n>ms" — e.g. "585ms", "7.66s", "1m26.4s". Returns total seconds.
function parseResetDuration(raw: string | null): number | null {
  if (!raw) {
    return null;
  }
  const match = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/);
  if (!match) {
    return null;
  }
  const [, hours, minutes, seconds, millis] = match;
  if (!hours && !minutes && !seconds && !millis) {
    return null;
  }
  return (
    Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0) + Number(millis ?? 0) / 1000
  );
}

function captureTokenStatus(headers: Headers, model: string): void {
  const remaining = headers.get('x-ratelimit-remaining-tokens');
  const limit = headers.get('x-ratelimit-limit-tokens');
  if (remaining === null || limit === null) {
    return;
  }
  const resetTokens = headers.get('x-ratelimit-reset-tokens');
  latestTokenStatus = {
    remainingTokens: Number(remaining),
    limitTokens: Number(limit),
    resetTokens,
    resetTokensSeconds: parseResetDuration(resetTokens),
    model,
    updatedAt: new Date().toISOString(),
  };
}

// Groq's TPM (per-minute) limit comes back in response headers, but TPD
// (per-day) doesn't — Groq just doesn't expose it. Approximated here by
// summing each response's usage.total_tokens into a counter that resets
// when the calendar date (server-local time) changes.
let dailyUsage = { date: todayKey(), totalTokens: 0 };

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function recordDailyUsage(totalTokens: number | undefined): void {
  if (!totalTokens) {
    return;
  }
  const key = todayKey();
  if (dailyUsage.date !== key) {
    dailyUsage = { date: key, totalTokens: 0 };
  }
  dailyUsage.totalTokens += totalTokens;
}

function currentDailyTokensUsed(): number {
  return dailyUsage.date === todayKey() ? dailyUsage.totalTokens : 0;
}

function hasImageContent(messages: ChatMessage[]): boolean {
  return messages.some(
    (m) => Array.isArray(m.content) && m.content.some((part) => part.type === 'image_url'),
  );
}

// MODEL_VISION emits verbose, unpredictable-length <think> reasoning before
// its answer, and this account's rate limit for it is a flat 8000 tokens
// per minute — covering BOTH the prompt and the completion budget we ask
// for. A fixed max_completion_tokens either truncates reasoning mid-thought
// (too low) or gets the whole request rejected by the rate limiter on
// image-heavy requests (too high, confirmed empirically: prompt ~1300
// tokens/image + max_completion_tokens 6000 exceeded the limit on a single
// image). So the completion budget is sized down as image count goes up,
// leaving headroom under the 8000 ceiling either way. This is a heuristic,
// not a guarantee — the truncated-<think> check below is the real backstop.
function resolveVisionMaxTokens(messages: ChatMessage[]): number {
  const imageCount = messages.reduce((count, m) => {
    if (!Array.isArray(m.content)) return count;
    return count + m.content.filter((p) => p.type === 'image_url').length;
  }, 0);
  const estimatedPromptTokens = 500 + imageCount * 1300;
  const safetyMargin = 300;
  const budget = 8000 - estimatedPromptTokens - safetyMargin;
  return Math.max(3000, Math.min(5500, budget));
}

// gpt-oss-120b (MODEL_SMART) has its own internal reasoning and can spend a
// meaningful share of its token budget on that before ever emitting the
// final answer, especially at reasoning_effort "high" (Deeper Insight
// mode) — combined with previously having NO explicit cap here (silently
// falling back to Groq's default, ~2048), that's a likely cause of "Model
// returned no text content." on this model. Every non-vision request now
// gets a generous explicit budget; MODEL_VISION keeps its own dynamic,
// rate-limit-aware budget from resolveVisionMaxTokens.
function resolveMaxCompletionTokens(
  model: string,
  reasoningEffort: 'high' | 'medium' | undefined,
  messages: ChatMessage[],
): number {
  if (model === MODEL_VISION) {
    return resolveVisionMaxTokens(messages);
  }
  return reasoningEffort ? 4096 : 2048;
}

const app = express();

const isDev = process.env['NODE_ENV'] !== 'production';
const allowedOrigin = process.env['ALLOWED_ORIGIN'] ?? 'http://localhost:4200';

app.use(
  cors({
    // In dev, the Angular CLI can land on a different port than 4200 if its
    // usual port is already taken, so allow any localhost origin instead of
    // hardcoding one. Production stays locked to ALLOWED_ORIGIN.
    origin: isDev ? /^http:\/\/localhost:\d+$/ : allowedOrigin,
  }),
);
// Pasted images are sent as base64 data URLs (up to 3 per message, up to
// 20MB base64 each — MODEL_VISION's real limits, confirmed against the
// live API) plus up to 50 messages of history that may themselves contain
// images, so the old 100kb text-only limit is nowhere near enough.
app.use(express.json({ limit: '75mb' }));

const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

app.post('/api/chat', chatLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validation = validateMessages(req.body);
    if ('error' in validation) {
      res.status(400).json({ error: validation.error });
      return;
    }
    if (validation.messages[validation.messages.length - 1].role !== 'user') {
      res.status(400).json({ error: 'The last message in the conversation must be from the user.' });
      return;
    }

    // Groq's API is OpenAI-compatible: messages take the same
    // { role, content } shape we already validate (content is either plain
    // text or a Groq-style content-part array for image messages), just
    // with a leading "system" message for the persona instead of a
    // separate param.
    const mode = (req.body as { mode?: unknown } | null)?.mode;
    // Neither text model understands images, so any image content forces
    // the vision model regardless of the selected mode.
    const model = hasImageContent(validation.messages) ? MODEL_VISION : resolveModel(mode);
    const reasoningEffort = model === MODEL_SMART ? resolveReasoningEffort(mode) : undefined;
    const maxCompletionTokens = resolveMaxCompletionTokens(model, reasoningEffort, validation.messages);
    const groqMessages = [
      { role: 'system' as const, content: resolveSystemPrompt(mode) },
      ...validation.messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    // Retries once on an empty/unusable response before giving up — this is
    // sometimes a transient issue (confirmed during this same investigation:
    // reasoning-heavy models occasionally burn their whole budget without
    // ever emitting visible content on a given attempt).
    const MAX_ATTEMPTS = 2;
    let text = '';
    let cutOffMidThink = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const { data: completion, response } = await groq.chat.completions
        .create({
          model,
          messages: groqMessages,
          // gpt-oss-120b only: spend more reasoning tokens for a deeper
          // answer. Ignored by other models, so it's safe to always pass it.
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
          max_completion_tokens: maxCompletionTokens,
        })
        .withResponse();

      captureTokenStatus(response.headers, model);
      recordDailyUsage(completion.usage?.total_tokens);

      const rawText = completion.choices[0]?.message?.content ?? '';
      const finishReason = completion.choices[0]?.finish_reason;
      console.log(
        `[chat] model=${model} mode=${String(mode)} attempt=${attempt}/${MAX_ATTEMPTS} ` +
          `finish_reason=${finishReason} contentLength=${rawText.length}`,
      );

      // MODEL_VISION emits its chain-of-thought inline as <think>...</think>
      // ahead of the actual answer (no separate reasoning field on this
      // model) — strip it so users only see the final reply. No-op for
      // models that don't do this.
      const stripped = rawText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      // Generation was cut off (finish_reason "length") mid-<think> block —
      // no closing tag — so the strip above found nothing to remove and
      // `stripped` would otherwise be the raw, confused reasoning dump.
      cutOffMidThink = finishReason === 'length' && rawText.includes('<think>') && !rawText.includes('</think>');

      if (stripped && !cutOffMidThink) {
        text = stripped;
        break;
      }

      if (attempt < MAX_ATTEMPTS) {
        console.warn(`[chat] empty/unusable response on attempt ${attempt} (finish_reason=${finishReason}), retrying`);
      }
    }

    if (!text) {
      if (cutOffMidThink) {
        res.status(502).json({
          error: 'The response was cut off before finishing. Please try again, maybe with fewer images or a shorter question.',
        });
        return;
      }
      res.status(502).json({ error: 'Model returned no text content.' });
      return;
    }

    res.json({ reply: text });
  } catch (err) {
    next(err);
  }
});

// Cheap in-memory read, no external calls — no rate limiter needed.
app.get('/api/token-status', (req: Request, res: Response) => {
  res.json({
    ...latestTokenStatus,
    dailyTokensUsed: currentDailyTokensUsed(),
  });
});

app.use('/api/conversations', conversationsRouter);

app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;

  console.error(`[error] ${req.method} ${req.originalUrl} failed: ${message}`);
  if (stack) {
    console.error(stack);
  }
  // Groq/Mongoose errors carry extra diagnostic fields beyond .message/.stack —
  // log the whole object too.
  console.error('[error] full error object:', err);

  res.status(500).json({
    error: 'Internal server error.',
    // Only exposed outside production — never ship raw error detail to real users.
    ...(isDev ? { devDetail: message } : {}),
  });
});

const port = Number(process.env['PORT'] ?? 8787);
app.listen(port, () => {
  console.log(`strong-type server listening on http://localhost:${port}`);
});
