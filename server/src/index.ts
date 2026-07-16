import path from 'node:path';
import dotenv from 'dotenv';
import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import Anthropic from '@anthropic-ai/sdk';

// Anchor to this file's directory (not process.cwd()) so the key loads
// correctly regardless of which directory the process was started from.
const envPath = path.resolve(__dirname, '..', '.env');
const dotenvResult = dotenv.config({ path: envPath });

if (dotenvResult.error) {
  console.warn(`[startup] Could not read .env at ${envPath}: ${dotenvResult.error.message}`);
} else {
  console.log(`[startup] Loaded environment variables from ${envPath}`);
}
console.log(`[startup] ANTHROPIC_API_KEY present: ${Boolean(process.env['ANTHROPIC_API_KEY'])}`);

if (!process.env['ANTHROPIC_API_KEY']) {
  throw new Error(
    `ANTHROPIC_API_KEY is not set (looked for it in ${envPath}). ` +
      'Copy server/.env.example to server/.env and fill in your key.',
  );
}

const anthropic = new Anthropic();

const MODEL = 'claude-sonnet-4-6';
const MAX_MESSAGE_LENGTH = 2000;
const MAX_HISTORY_LENGTH = 50;

const app = express();
app.use(cors({ origin: process.env['ALLOWED_ORIGIN'] ?? 'http://localhost:4200' }));
app.use(express.json({ limit: '100kb' }));

const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

function validateMessages(body: unknown): { error: string } | { messages: ChatMessage[] } {
  const messages = (body as { messages?: unknown } | null)?.messages;

  if (!Array.isArray(messages) || messages.length === 0) {
    return { error: 'Field "messages" is required and must be a non-empty array.' };
  }
  if (messages.length > MAX_HISTORY_LENGTH) {
    return { error: `Conversation history must be at most ${MAX_HISTORY_LENGTH} messages.` };
  }

  for (const item of messages) {
    const role = (item as Partial<ChatMessage> | null)?.role;
    const content = (item as Partial<ChatMessage> | null)?.content;

    if (role !== 'user' && role !== 'assistant') {
      return { error: 'Each message must have role "user" or "assistant".' };
    }
    if (typeof content !== 'string' || content.trim().length === 0) {
      return { error: 'Each message must have non-empty string content.' };
    }
    if (content.length > MAX_MESSAGE_LENGTH) {
      return { error: `Each message must be at most ${MAX_MESSAGE_LENGTH} characters.` };
    }
  }

  if (messages[messages.length - 1].role !== 'user') {
    return { error: 'The last message in the conversation must be from the user.' };
  }

  return { messages: messages as ChatMessage[] };
}

app.post('/api/chat', chatLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validation = validateMessages(req.body);
    if ('error' in validation) {
      res.status(400).json({ error: validation.error });
      return;
    }

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system:
        'You are the helpful conversational AI assistant embedded in Strong Type, ' +
        'a site for strengthening and improving written text. Be friendly, clear, and concise.',
      messages: validation.messages.map((m) => ({ role: m.role, content: m.content })),
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    if (!textBlock) {
      res.status(502).json({ error: 'Model returned no text content.' });
      return;
    }

    res.json({ reply: textBlock.text });
  } catch (err) {
    next(err);
  }
});

const isDev = process.env['NODE_ENV'] !== 'production';

app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;

  console.error(`[error] ${req.method} ${req.originalUrl} failed: ${message}`);
  if (stack) {
    console.error(stack);
  }
  // Anthropic SDK errors carry extra diagnostic fields (status, request id,
  // upstream error body) beyond .message/.stack — log the whole object too.
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
