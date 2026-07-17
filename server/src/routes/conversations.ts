import { Router, Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import { Conversation } from '../models/conversation';
import { isMongoConnected } from '../db';
import { validateMessages } from '../validation';

export const conversationsRouter = Router();

const conversationsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});
conversationsRouter.use(conversationsLimiter);

function requireMongo(req: Request, res: Response, next: NextFunction): void {
  if (!isMongoConnected()) {
    res.status(503).json({ error: 'Conversation storage is not available right now.' });
    return;
  }
  next();
}
conversationsRouter.use(requireMongo);

function requireValidId(req: Request, res: Response, next: NextFunction): void {
  if (!mongoose.isValidObjectId(req.params['id'])) {
    res.status(400).json({ error: 'Invalid conversation id.' });
    return;
  }
  next();
}

function titleFromMessages(messages: { role: string; content: string }[]): string {
  const firstUserMessage = messages.find((m) => m.role === 'user');
  if (!firstUserMessage) {
    return 'New Chat';
  }
  const trimmed = firstUserMessage.content.trim().replace(/\s+/g, ' ');
  if (!trimmed) {
    return 'New Chat';
  }
  return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
}

function readOptionalTitle(body: unknown): string | undefined {
  const title = (body as { title?: unknown } | null)?.title;
  return typeof title === 'string' && title.trim() ? title.trim() : undefined;
}

// GET /api/conversations — list all saved conversations (id + title only)
conversationsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const conversations = await Conversation.find({}, { title: 1 })
      .sort({ updatedAt: -1 })
      .limit(100)
      .lean();
    res.json({
      conversations: conversations.map((c) => ({ id: String(c._id), title: c.title })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/conversations/:id — full messages for one conversation
conversationsRouter.get(
  '/:id',
  requireValidId,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const conversation = await Conversation.findById(req.params['id']).lean();
      if (!conversation) {
        res.status(404).json({ error: 'Conversation not found.' });
        return;
      }
      res.json({
        id: String(conversation._id),
        title: conversation.title,
        messages: conversation.messages,
      });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/conversations — save a new conversation
conversationsRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validation = validateMessages(req.body);
    if ('error' in validation) {
      res.status(400).json({ error: validation.error });
      return;
    }

    const title = readOptionalTitle(req.body) ?? titleFromMessages(validation.messages);
    const conversation = await Conversation.create({ title, messages: validation.messages });
    res.status(201).json({ id: String(conversation._id), title: conversation.title });
  } catch (err) {
    next(err);
  }
});

// PUT /api/conversations/:id — update an existing conversation
conversationsRouter.put(
  '/:id',
  requireValidId,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const validation = validateMessages(req.body);
      if ('error' in validation) {
        res.status(400).json({ error: validation.error });
        return;
      }

      const update: { messages: typeof validation.messages; title?: string } = {
        messages: validation.messages,
      };
      const title = readOptionalTitle(req.body);
      if (title) {
        update.title = title;
      }

      const conversation = await Conversation.findByIdAndUpdate(req.params['id'], update, {
        returnDocument: 'after',
      });
      if (!conversation) {
        res.status(404).json({ error: 'Conversation not found.' });
        return;
      }
      res.json({ id: String(conversation._id), title: conversation.title });
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /api/conversations/:id — delete one
conversationsRouter.delete(
  '/:id',
  requireValidId,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await Conversation.findByIdAndDelete(req.params['id']);
      if (!result) {
        res.status(404).json({ error: 'Conversation not found.' });
        return;
      }
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);
