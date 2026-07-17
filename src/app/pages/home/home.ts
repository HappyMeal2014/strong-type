import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
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
} from '@lucide/angular';

const CHAT_URL = 'http://localhost:8787/api/chat';
const CONVERSATIONS_URL = 'http://localhost:8787/api/conversations';
// Must match the server's MAX_HISTORY_LENGTH — the backend rejects longer
// payloads outright, so a long local conversation has to be windowed down
// before it's sent, or every request past this point fails forever.
const MAX_HISTORY_SENT = 50;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ConversationSummary {
  id: string;
  title: string;
}

@Component({
  selector: 'app-home',
  imports: [
    LucidePlus,
    LucideChevronDown,
    LucideSearch,
    LucideMic,
    LucideMenu,
    LucideTrash2,
    NgTemplateOutlet,
  ],
  templateUrl: './home.html',
  styleUrl: './home.css',
})
export class Home {
  private readonly http = inject(HttpClient);
  private pendingRequest: Subscription | null = null;

  protected readonly messages = signal<ChatMessage[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly hasMessages = computed(() => this.messages().length > 0);

  protected readonly conversationsList = signal<ConversationSummary[]>([]);
  protected readonly activeConversationId = signal<string | null>(null);
  protected readonly sidebarOpen = signal(false);

  private readonly scrollAnchor = viewChild<ElementRef<HTMLDivElement>>('scrollAnchor');

  constructor() {
    effect(() => {
      this.messages();
      this.loading();
      queueMicrotask(() => this.scrollAnchor()?.nativeElement.scrollIntoView({ block: 'end' }));
    });

    this.loadConversations();
  }

  protected handleEnter(input: HTMLInputElement): void {
    const text = input.value.trim();
    if (!text || this.loading()) {
      return;
    }
    input.value = '';
    this.submit(text);
  }

  protected newChat(input: HTMLInputElement): void {
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

  private resetChat(input: HTMLInputElement): void {
    this.messages.set([]);
    this.error.set(null);
    this.loading.set(false);
    this.activeConversationId.set(null);
    input.value = '';
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

  private submit(text: string): void {
    this.messages.update((history) => [...history, { role: 'user', content: text }]);
    this.loading.set(true);
    this.error.set(null);

    const payload = this.messages().slice(-MAX_HISTORY_SENT);
    this.pendingRequest = this.http
      .post<{ reply: string }>(CHAT_URL, { messages: payload })
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
