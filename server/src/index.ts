import path from 'node:path';
import dotenv from 'dotenv';
import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import Groq from 'groq-sdk';
import { validateMessages } from './validation';
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
  'clearly asks for more detail.';

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
  'information, just say it more economically.';

// Deeper Insight is the most thorough tier this app offers: the largest
// model, highest reasoning effort, and explicitly told to go deep and use
// structure where it helps, not to hold back for brevity — but "thorough"
// means covering more ground, not restating the same ground in more words.
const SYSTEM_PROMPT_SMART =
  'You are the helpful conversational AI assistant embedded in Strong Type, ' +
  'a site for strengthening and improving written text. Explain things simply, ' +
  'the way you would to a 12-year-old: short sentences, easy everyday words, ' +
  'no jargon. This is "Deeper Insight" mode, the most thorough option this ' +
  'app offers — give a comprehensive, well-structured answer that covers the ' +
  'relevant details, reasoning, and useful context in full rather than a ' +
  'quick summary, using headings or a short list if that makes it clearer, ' +
  'while keeping the language simple and easy to follow. Keep every bit of ' +
  'that depth — cover the same range of sub-topics you otherwise would; do ' +
  'not drop a topic or example just to save space. Instead write tightly: ' +
  'no filler phrases, no throat-clearing intros, and no restating a point ' +
  'you already made (including in a closing "recap" or "bottom line" ' +
  'section — do not add one). Each sentence should carry new information, ' +
  'so the same substance takes up ' +
  'less text.';

function resolveSystemPrompt(mode: unknown): string {
  if (mode === 'smart') return SYSTEM_PROMPT_SMART;
  if (mode === 'teenager') return SYSTEM_PROMPT_TEENAGER;
  return SYSTEM_PROMPT_GENERAL;
}

// Deeper Insight reasons harder than Insight — same model, different token
// budget for reasoning — which also helps keep the two visibly distinct.
function resolveReasoningEffort(mode: unknown): 'high' | 'medium' | undefined {
  if (mode === 'smart') return 'high';
  if (mode === 'teenager') return 'medium';
  return undefined;
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
app.use(express.json({ limit: '100kb' }));

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
    // { role, content } shape we already validate, just with a leading
    // "system" message for the persona instead of a separate param.
    const mode = (req.body as { mode?: unknown } | null)?.mode;
    const model = resolveModel(mode);
    const reasoningEffort = resolveReasoningEffort(mode);
    const completion = await groq.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: resolveSystemPrompt(mode) },
        ...validation.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      // gpt-oss-120b only: spend more reasoning tokens for a deeper answer.
      // Ignored by other models, so it's safe to always pass it.
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    });

    const text = completion.choices[0]?.message?.content;
    if (!text) {
      res.status(502).json({ error: 'Model returned no text content.' });
      return;
    }

    res.json({ reply: text });
  } catch (err) {
    next(err);
  }
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
