// ~4000 chars is roughly 800-1000 tokens at typical English text density
// (~4-5 chars/token) — comfortably inside Groq's per-request token limits
// while allowing much longer questions/pastes than the old 2000 cap.
export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_HISTORY_LENGTH = 50;
// MODEL_VISION's (qwen/qwen3.6-27b) real per-request limits, confirmed
// against the live Groq API — not the 5-image/4MB figures commonly quoted
// for Llama 4 Scout/Maverick, which aren't available on this account.
export const MAX_IMAGES_PER_MESSAGE = 3;
export const MAX_IMAGE_BASE64_BYTES = 20 * 1024 * 1024;

export interface TextContentPart {
  type: 'text';
  text: string;
}

export interface ImageUrlContentPart {
  type: 'image_url';
  image_url: { url: string };
}

export type ContentPart = TextContentPart | ImageUrlContentPart;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | ContentPart[];
}

const DATA_URL_PREFIX = /^data:image\/[a-zA-Z0-9.+-]+;base64,/;

function validateContentPart(part: unknown): { error: string } | { part: ContentPart } {
  const type = (part as Partial<ContentPart> | null)?.type;

  if (type === 'text') {
    const text = (part as Partial<TextContentPart> | null)?.text;
    if (typeof text !== 'string' || text.trim().length === 0) {
      return { error: 'A "text" content part must have non-empty string text.' };
    }
    if (text.length > MAX_MESSAGE_LENGTH) {
      return { error: `Each text part must be at most ${MAX_MESSAGE_LENGTH} characters.` };
    }
    return { part: { type: 'text', text } };
  }

  if (type === 'image_url') {
    const url = (part as Partial<ImageUrlContentPart> | null)?.image_url?.url;
    if (typeof url !== 'string' || !DATA_URL_PREFIX.test(url)) {
      return { error: 'Each image must be a base64 data URL (e.g. "data:image/png;base64,...").' };
    }
    const base64 = url.slice(url.indexOf(',') + 1);
    // Actual decoded byte size is ~3/4 of the base64 string length, but the
    // limit is on the base64 payload itself (matches what the client checks
    // before ever sending it), so compare the encoded length directly.
    if (base64.length > MAX_IMAGE_BASE64_BYTES) {
      return { error: `Each image must be under ${MAX_IMAGE_BASE64_BYTES / (1024 * 1024)}MB once base64-encoded.` };
    }
    return { part: { type: 'image_url', image_url: { url } } };
  }

  return { error: 'Each content part must have type "text" or "image_url".' };
}

function validateContent(content: unknown): { error: string } | { content: string | ContentPart[] } {
  if (typeof content === 'string') {
    if (content.trim().length === 0) {
      return { error: 'Each message must have non-empty string content.' };
    }
    if (content.length > MAX_MESSAGE_LENGTH) {
      return { error: `Each message must be at most ${MAX_MESSAGE_LENGTH} characters.` };
    }
    return { content };
  }

  if (Array.isArray(content)) {
    if (content.length === 0) {
      return { error: 'A message with array content must include at least one part.' };
    }

    const imageCount = content.filter((p) => (p as Partial<ContentPart> | null)?.type === 'image_url').length;
    if (imageCount > MAX_IMAGES_PER_MESSAGE) {
      return { error: `A message can include at most ${MAX_IMAGES_PER_MESSAGE} images.` };
    }
    if (imageCount === 0) {
      return { error: 'A message with array content must include at least one image.' };
    }

    const parts: ContentPart[] = [];
    for (const item of content) {
      const result = validateContentPart(item);
      if ('error' in result) {
        return result;
      }
      parts.push(result.part);
    }
    return { content: parts };
  }

  return { error: 'Each message must have string or array content.' };
}

export function validateMessages(body: unknown): { error: string } | { messages: ChatMessage[] } {
  const messages = (body as { messages?: unknown } | null)?.messages;

  if (!Array.isArray(messages) || messages.length === 0) {
    return { error: 'Field "messages" is required and must be a non-empty array.' };
  }
  if (messages.length > MAX_HISTORY_LENGTH) {
    return { error: `Conversation history must be at most ${MAX_HISTORY_LENGTH} messages.` };
  }

  const validated: ChatMessage[] = [];
  for (const item of messages) {
    const role = (item as Partial<ChatMessage> | null)?.role;
    if (role !== 'user' && role !== 'assistant') {
      return { error: 'Each message must have role "user" or "assistant".' };
    }

    const contentResult = validateContent((item as Partial<ChatMessage> | null)?.content);
    if ('error' in contentResult) {
      return contentResult;
    }

    validated.push({ role, content: contentResult.content });
  }

  return { messages: validated };
}
