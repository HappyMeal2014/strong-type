import { Schema, model } from 'mongoose';

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

const messageSchema = new Schema<ConversationMessage>(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true },
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
