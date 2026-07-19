import {
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { NgTemplateOutlet } from '@angular/common';
import { Observable, Subscription, map, of, tap } from 'rxjs';
import {
  LucideChevronDown,
  LucideMenu,
  LucideMic,
  LucidePlus,
  LucideSearch,
  LucideTrash2,
  LucideX,
} from '@lucide/angular';

const CHAT_URL = 'http://localhost:8787/api/chat';
const CONVERSATIONS_URL = 'http://localhost:8787/api/conversations';
const TOKEN_STATUS_URL = 'http://localhost:8787/api/token-status';
// Must match the server's MAX_HISTORY_LENGTH — the backend rejects longer
// payloads outright, so a long local conversation has to be windowed down
// before it's sent, or every request past this point fails forever.
const MAX_HISTORY_SENT = 50;

// Must match the server's equivalents in validation.ts — the real
// per-request limits of the vision model actually available on this
// account (qwen/qwen3.6-27b), confirmed against the live Groq API.
const MAX_IMAGES_PER_MESSAGE = 3;
const MAX_IMAGE_BASE64_BYTES = 20 * 1024 * 1024;

// Must match the server's MAX_MESSAGE_LENGTH — enforced here too so a
// too-long message is caught instantly instead of round-tripping to the
// backend just to be rejected.
const MAX_MESSAGE_LENGTH = 4000;

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

interface PendingImage {
  id: string;
  dataUrl: string;
  sizeBytes: number;
  // FileReader is async, so a slot is reserved (loading: true, empty
  // dataUrl) synchronously the moment a paste is accepted — otherwise the
  // MAX_IMAGES_PER_MESSAGE check below can't see in-flight reads yet, and
  // pasting several images at once (or in quick succession) blows past it.
  loading: boolean;
}

interface ConversationSummary {
  id: string;
  title: string;
}

interface TokenStatus {
  remainingTokens: number | null;
  limitTokens: number | null;
  resetTokens: string | null;
  resetTokensSeconds: number | null;
  model: string | null;
  updatedAt: string | null;
  dailyTokensUsed: number;
}

export type ChatMode = 'general' | 'teenager' | 'smart';

// Short form shown on the collapsed pill once a mode is selected. The
// dropdown list shows the full "(kids)/(teenager)/(adult)" labels directly
// in the template, since those never change once opened.
const MODE_LABELS_SHORT: Record<ChatMode, string> = {
  general: 'Explore',
  teenager: 'Insight',
  smart: 'Deeper Insight',
};

@Component({
  selector: 'app-home',
  imports: [
    LucidePlus,
    LucideChevronDown,
    LucideSearch,
    LucideMic,
    LucideMenu,
    LucideTrash2,
    LucideX,
    NgTemplateOutlet,
  ],
  templateUrl: './home.html',
  styleUrl: './home.css',
})
export class Home implements OnDestroy {
  private readonly http = inject(HttpClient);
  private pendingRequest: Subscription | null = null;

  protected readonly messages = signal<ChatMessage[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly hasMessages = computed(() => this.messages().length > 0);

  protected readonly conversationsList = signal<ConversationSummary[]>([]);
  protected readonly activeConversationId = signal<string | null>(null);
  protected readonly sidebarOpen = signal(false);

  protected readonly mode = signal<ChatMode>('general');
  protected readonly modeLabel = computed(() => MODE_LABELS_SHORT[this.mode()]);
  protected readonly modeMenuOpen = signal(false);

  protected readonly pendingImages = signal<PendingImage[]>([]);

  protected readonly messageLength = signal(0);
  protected readonly messageLengthLimit = MAX_MESSAGE_LENGTH;
  protected readonly messageOverLimit = computed(() => this.messageLength() > MAX_MESSAGE_LENGTH);

  protected readonly tokenStatusOpen = signal(false);
  protected readonly tokenStatus = signal<TokenStatus | null>(null);
  protected readonly tokenStatusLoading = signal(false);

  // Ticks once a second (only while the popover is open — see
  // toggleTokenStatus) so tokenResetSeconds recomputes into a live
  // countdown instead of the static value from the last fetch.
  private readonly now = signal(Date.now());
  private tokenCountdownInterval: ReturnType<typeof setInterval> | null = null;

  // Derives the *actual* remaining reset time by subtracting elapsed time
  // (now - updatedAt) from the reset duration captured at fetch time,
  // instead of just displaying that captured duration statically. Clamped
  // to >= 0 so it never goes negative or shows a stale/impossible number
  // after the popover's been open a while.
  protected readonly tokenResetSeconds = computed<number | null>(() => {
    const status = this.tokenStatus();
    if (status?.resetTokensSeconds == null || !status.updatedAt) {
      return null;
    }
    const elapsedSeconds = (this.now() - new Date(status.updatedAt).getTime()) / 1000;
    return Math.max(0, status.resetTokensSeconds - elapsedSeconds);
  });

  private readonly scrollAnchor = viewChild<ElementRef<HTMLDivElement>>('scrollAnchor');

  constructor() {
    effect(() => {
      this.messages();
      this.loading();
      queueMicrotask(() => this.scrollAnchor()?.nativeElement.scrollIntoView({ block: 'end' }));
    });

    this.loadConversations();
  }

  protected handleKeydown(input: HTMLTextAreaElement, event: KeyboardEvent): void {
    if (event.key !== 'Enter') {
      return;
    }
    if (event.shiftKey) {
      // Let the browser insert the newline; autoResize picks it up via (input).
      return;
    }
    event.preventDefault();

    const text = input.value.trim();
    const images = this.pendingImages();
    if ((!text && images.length === 0) || this.loading()) {
      return;
    }
    if (images.some((img) => img.loading)) {
      // FileReader resolves in milliseconds for local images — this is a
      // brief transient state, not a real wait.
      this.error.set('Still reading a pasted image — try sending again in a moment.');
      return;
    }
    if (text.length > MAX_MESSAGE_LENGTH) {
      // Mirrors the backend's MAX_MESSAGE_LENGTH check — caught here first
      // so it's instant instead of a round trip just to be rejected.
      this.error.set(
        `Your message is ${text.length.toLocaleString()} characters — please keep it under ${MAX_MESSAGE_LENGTH.toLocaleString()}.`,
      );
      return;
    }

    input.value = '';
    this.autoResize(input);
    this.updateMessageLength(input);
    this.pendingImages.set([]);
    this.submit(this.buildContent(text, images));
  }

  // Keeps the live character counter in sync — bound to the textarea's
  // (input) event alongside autoResize.
  protected updateMessageLength(input: HTMLTextAreaElement): void {
    this.messageLength.set(input.value.length);
  }

  // Intercepts pasted images so they become thumbnails instead of pasting
  // as unusable garbage (or nothing) into the text field. Plain-text pastes
  // are left alone — only fires preventDefault once an image is found.
  protected handlePaste(event: ClipboardEvent): void {
    const items = event.clipboardData?.items;
    if (!items) {
      return;
    }

    const imageFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          imageFiles.push(file);
        }
      }
    }
    if (imageFiles.length === 0) {
      return;
    }
    event.preventDefault();

    for (const file of imageFiles) {
      if (this.pendingImages().length >= MAX_IMAGES_PER_MESSAGE) {
        this.error.set(`You can attach at most ${MAX_IMAGES_PER_MESSAGE} images per message.`);
        break;
      }
      // Reserve the slot synchronously, before FileReader resolves — see
      // the "loading" note on PendingImage for why this matters.
      const id = crypto.randomUUID();
      this.pendingImages.update((images) => [...images, { id, dataUrl: '', sizeBytes: 0, loading: true }]);
      this.readImageFile(file, id);
    }
  }

  protected removeImage(id: string): void {
    this.pendingImages.update((images) => images.filter((img) => img.id !== id));
  }

  // Renders either shape of ChatMessage.content as plain text for display.
  protected textOf(content: ChatMessage['content']): string {
    if (typeof content === 'string') {
      return content;
    }
    return content
      .filter((part): part is TextContentPart => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
  }

  // Extracts image data URLs from either shape of ChatMessage.content for
  // rendering thumbnails in the message log.
  protected imagesOf(content: ChatMessage['content']): string[] {
    if (typeof content === 'string') {
      return [];
    }
    return content
      .filter((part): part is ImageUrlContentPart => part.type === 'image_url')
      .map((part) => part.image_url.url);
  }

  private buildContent(text: string, images: PendingImage[]): string | ContentPart[] {
    if (images.length === 0) {
      return text;
    }
    const parts: ContentPart[] = [];
    if (text) {
      parts.push({ type: 'text', text });
    }
    for (const image of images) {
      parts.push({ type: 'image_url', image_url: { url: image.dataUrl } });
    }
    return parts;
  }

  // Fills in the slot reserved for `id` in handlePaste once the file is
  // actually read (or drops it, on error/oversize).
  private readImageFile(file: File, id: string): void {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      if (base64.length > MAX_IMAGE_BASE64_BYTES) {
        const sizeMb = (base64.length / (1024 * 1024)).toFixed(1);
        const maxMb = MAX_IMAGE_BASE64_BYTES / (1024 * 1024);
        this.error.set(
          `That image is ${sizeMb}MB once encoded — must be under ${maxMb}MB. It was not added.`,
        );
        this.pendingImages.update((images) => images.filter((img) => img.id !== id));
        return;
      }
      this.pendingImages.update((images) =>
        images.map((img) =>
          img.id === id ? { ...img, dataUrl, sizeBytes: base64.length, loading: false } : img,
        ),
      );
    };
    reader.onerror = () => {
      this.error.set('Could not read that pasted image. Please try again.');
      this.pendingImages.update((images) => images.filter((img) => img.id !== id));
    };
    reader.readAsDataURL(file);
  }

  // Grows the textarea to fit its content, up to the CSS max-height (which
  // then takes over with internal scrolling) — reset height to 'auto' first
  // so shrinking (e.g. after deleting a line, or clearing on submit) is
  // picked up too, not just growth.
  protected autoResize(textarea: HTMLTextAreaElement): void {
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }

  protected newChat(input: HTMLTextAreaElement): void {
    this.pendingRequest?.unsubscribe();
    this.pendingRequest = null;

    if (!this.hasMessages()) {
      this.resetChat(input);
      return;
    }

    // Wait for the save to actually finish before wiping the conversation —
    // a fire-and-forget save meant a failed request silently lost the chat
    // with no feedback, since clearing happened regardless of the outcome.
    this.persistConversation().subscribe({
      next: () => this.resetChat(input),
      error: () => {
        this.error.set(
          'Could not save this conversation, so it has not been cleared. Please try again.',
        );
      },
    });
  }

  protected loadConversation(id: string): void {
    if (this.activeConversationId() === id) {
      this.sidebarOpen.set(false);
      return;
    }

    this.pendingRequest?.unsubscribe();
    this.pendingRequest = null;
    this.sidebarOpen.set(false);

    const beforeSwitch$ = this.hasMessages() ? this.persistConversation() : of(undefined);
    beforeSwitch$.subscribe({
      next: () => this.fetchConversation(id),
      error: () => {
        this.error.set(
          'Could not save the current conversation, so the switch was cancelled. Please try again.',
        );
      },
    });
  }

  protected selectMode(mode: ChatMode): void {
    this.mode.set(mode);
    this.modeMenuOpen.set(false);
  }

  // Fetches fresh on every open rather than once, so the popover reflects
  // usage from messages sent since it was last checked. The countdown
  // interval only runs while the popover is actually visible — no point
  // ticking a signal nobody's reading.
  protected toggleTokenStatus(): void {
    const opening = !this.tokenStatusOpen();
    this.tokenStatusOpen.set(opening);

    if (this.tokenCountdownInterval !== null) {
      clearInterval(this.tokenCountdownInterval);
      this.tokenCountdownInterval = null;
    }
    if (!opening) {
      return;
    }

    this.tokenStatusLoading.set(true);
    this.http.get<TokenStatus>(TOKEN_STATUS_URL).subscribe({
      next: (res) => {
        this.tokenStatus.set(res);
        this.tokenStatusLoading.set(false);
        this.now.set(Date.now());
      },
      error: () => {
        this.tokenStatus.set(null);
        this.tokenStatusLoading.set(false);
      },
    });
    this.tokenCountdownInterval = setInterval(() => this.now.set(Date.now()), 1000);
  }

  // "7.66" -> "8s"; "86.4" -> "1m 26s". Whole seconds only — this is a
  // rough live indicator, not a stopwatch.
  protected formatCountdown(seconds: number): string {
    const total = Math.ceil(seconds);
    const minutes = Math.floor(total / 60);
    const remainingSeconds = total % 60;
    return minutes > 0 ? `${minutes}m ${remainingSeconds}s` : `${remainingSeconds}s`;
  }

  ngOnDestroy(): void {
    if (this.tokenCountdownInterval !== null) {
      clearInterval(this.tokenCountdownInterval);
    }
  }

  protected deleteConversation(id: string, event: Event): void {
    event.stopPropagation();

    this.http.delete(`${CONVERSATIONS_URL}/${id}`).subscribe({
      next: () => {
        this.conversationsList.update((list) => list.filter((c) => c.id !== id));
        if (this.activeConversationId() === id) {
          // The conversation currently open was deleted out from under it —
          // drop back to a fresh chat rather than leaving a dangling
          // reference to a conversation that no longer exists.
          this.pendingRequest?.unsubscribe();
          this.pendingRequest = null;
          this.messages.set([]);
          this.error.set(null);
          this.loading.set(false);
          this.activeConversationId.set(null);
        }
      },
      error: () => {
        this.error.set('Could not delete that conversation. Please try again.');
      },
    });
  }

  private fetchConversation(id: string): void {
    this.error.set(null);
    this.loading.set(false);

    this.http
      .get<{ id: string; title: string; messages: ChatMessage[] }>(`${CONVERSATIONS_URL}/${id}`)
      .subscribe({
        next: (res) => {
          this.messages.set(res.messages);
          this.activeConversationId.set(res.id);
        },
        error: () => {
          this.error.set('Could not load that conversation. Please try again.');
        },
      });
  }

  private resetChat(input: HTMLTextAreaElement): void {
    this.messages.set([]);
    this.error.set(null);
    this.loading.set(false);
    this.activeConversationId.set(null);
    this.pendingImages.set([]);
    input.value = '';
    this.autoResize(input);
    this.updateMessageLength(input);
  }

  private loadConversations(): void {
    this.http.get<{ conversations: ConversationSummary[] }>(CONVERSATIONS_URL).subscribe({
      next: (res) => this.conversationsList.set(res.conversations),
      // Persistence may not be configured (e.g. MONGODB_URI unset) — the
      // sidebar just stays empty rather than blocking the chat itself.
      error: () => {},
    });
  }

  // Returns an observable so callers that need to know the outcome (New
  // Chat, switching conversations) can wait for it; the per-message
  // autosave in submit() just subscribes and ignores the result.
  private persistConversation(): Observable<void> {
    const currentMessages = this.messages();
    if (currentMessages.length === 0) {
      return of(undefined);
    }

    const id = this.activeConversationId();
    if (id) {
      return this.http
        .put(`${CONVERSATIONS_URL}/${id}`, { messages: currentMessages })
        .pipe(map(() => undefined));
    }

    return this.http.post<ConversationSummary>(CONVERSATIONS_URL, { messages: currentMessages }).pipe(
      tap((res) => {
        this.activeConversationId.set(res.id);
        this.loadConversations();
      }),
      map(() => undefined),
    );
  }

  private submit(content: string | ContentPart[]): void {
    this.messages.update((history) => [...history, { role: 'user', content }]);
    this.loading.set(true);
    this.error.set(null);

    const payload = this.messages().slice(-MAX_HISTORY_SENT);
    this.pendingRequest = this.http
      .post<{ reply: string }>(CHAT_URL, { messages: payload, mode: this.mode() })
      .subscribe({
        next: (response) => {
          this.messages.update((history) => [
            ...history,
            { role: 'assistant', content: response.reply },
          ]);
          this.loading.set(false);
          this.pendingRequest = null;
          // Best-effort autosave after each exchange — a failed save here
          // shouldn't interrupt live chat, so it stays fire-and-forget.
          this.persistConversation().subscribe({ error: () => {} });
        },
        error: (err: HttpErrorResponse) => {
          this.error.set(err.error?.error ?? 'Something went wrong. Please try again.');
          this.loading.set(false);
          this.pendingRequest = null;
          // Persist the user's message even though the reply failed, so it
          // isn't lost if the page is closed.
          this.persistConversation().subscribe({ error: () => {} });
        },
      });
  }
}
