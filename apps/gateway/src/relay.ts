/**
 * Token relay (ARCH §1.1, NFR-2a).
 *
 * Chunks go to the WebSocket immediately; message rows flush every ~250 ms
 * and on finish — never per token. First token = provider TTFB + <5 ms of us.
 * Stream 01 wires the relay to the echo job; stream 03 feeds it from real
 * model streams through the same interface.
 */

export interface RelaySink {
  /** Called per chunk — must be cheap: enqueue to WS, no I/O. */
  onChunk(text: string): void;
  /** Coalesced persistence; called at most every FLUSH_MS or on finish. */
  flush(): void;
}

const FLUSH_MS = 250;

export class TokenRelay {
  #buffer = "";
  #lastFlush = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #finished = false;

  constructor(private readonly sink: RelaySink) {}

  push(chunk: string): void {
    if (this.#finished) return;
    this.sink.onChunk(chunk);
    this.#buffer += chunk;
    const now = Date.now();
    if (now - this.#lastFlush >= FLUSH_MS) {
      this.#lastFlush = now;
      this.sink.flush();
      return;
    }
    if (!this.#timer) {
      this.#timer = setTimeout(() => {
        this.#timer = null;
        if (!this.#finished) {
          this.#lastFlush = Date.now();
          this.sink.flush();
        }
      }, FLUSH_MS);
    }
  }

  finish(): string {
    if (!this.#finished) {
      this.#finished = true;
      if (this.#timer) clearTimeout(this.#timer);
      this.sink.flush();
    }
    return this.#buffer;
  }

  get text(): string {
    return this.#buffer;
  }
}