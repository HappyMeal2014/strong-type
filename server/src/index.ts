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

const MODEL = 'llama-3.3-70b-versatile';
const SYSTEM_PROMPT =
  'You are the helpful conversational AI assistant embedded in Strong Type, ' +
  'a site for strengthening and improving written text. Explain things simply, ' +
  'the way you would to a 12-year-old: short sentences, easy everyday words, ' +
  'no jargon. Keep replies short — a few sentences at most, unless the user ' +
  'clearly asks for more detail.';

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
    const completion = await groq.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...validation.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
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
