export const MAX_MESSAGE_LENGTH = 2000;
export const MAX_HISTORY_LENGTH = 50;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export function validateMessages(body: unknown): { error: string } | { messages: ChatMessage[] } {
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

  return { messages: messages as ChatMessage[] };
}
