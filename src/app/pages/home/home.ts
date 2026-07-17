import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { LucideChevronDown, LucideMic, LucidePlus, LucideSearch } from '@lucide/angular';

const CHAT_URL = 'http://localhost:8787/api/chat';
// Must match the server's MAX_HISTORY_LENGTH — the backend rejects longer
// payloads outright, so a long local conversation has to be windowed down
// before it's sent, or every request past this point fails forever.
const MAX_HISTORY_SENT = 50;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

@Component({
  selector: 'app-home',
  imports: [LucidePlus, LucideChevronDown, LucideSearch, LucideMic],
  templateUrl: './home.html',
  styleUrl: './home.css',
})
export class Home {
  private readonly http = inject(HttpClient);

  protected readonly messages = signal<ChatMessage[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly hasMessages = computed(() => this.messages().length > 0);

  private readonly scrollAnchor = viewChild<ElementRef<HTMLDivElement>>('scrollAnchor');

  constructor() {
    effect(() => {
      this.messages();
      this.loading();
      queueMicrotask(() => this.scrollAnchor()?.nativeElement.scrollIntoView({ block: 'end' }));
    });
  }

  protected handleEnter(input: HTMLInputElement): void {
    const text = input.value.trim();
    if (!text || this.loading()) {
      return;
    }
    input.value = '';
    this.submit(text);
  }

  private submit(text: string): void {
    this.messages.update((history) => [...history, { role: 'user', content: text }]);
    this.loading.set(true);
    this.error.set(null);

    const payload = this.messages().slice(-MAX_HISTORY_SENT);
    this.http.post<{ reply: string }>(CHAT_URL, { messages: payload }).subscribe({
      next: (response) => {
        this.messages.update((history) => [
          ...history,
          { role: 'assistant', content: response.reply },
        ]);
        this.loading.set(false);
      },
      error: (err: HttpErrorResponse) => {
        this.error.set(err.error?.error ?? 'Something went wrong. Please try again.');
        this.loading.set(false);
      },
    });
  }
}
