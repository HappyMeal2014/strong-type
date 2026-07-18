import { Schema, model } from 'mongoose';
import type { ContentPart } from '../validation';

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string | ContentPart[];
}

const messageSchema = new Schema<ConversationMessage>(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    // Mixed, not String: a message's content is either plain text or an
    // array of Groq-style content parts (text/image_url) once images are
    // attached — see validation.ts's ChatMessage.content.
    content: { type: Schema.Types.Mixed, required: true },
  },
  { _id: false },
);

const conversationSchema = new Schema(
  {
    title: { type: String, required: true, default: 'New Chat' },
    messages: { type: [messageSchema], default: [] },
  },
  { timestamps: true },
);

// The conversation list is always sorted by recency — index it so that
// stays an index scan instead of a full collection scan as the number of
// saved conversations grows.
conversationSchema.index({ updatedAt: -1 });

export const Conversation = model('Conversation', conversationSchema);
