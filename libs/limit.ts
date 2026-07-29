// A counting semaphore, used to cap how many model calls are in flight at once.
//
// The stages fan out with bare Promise.all — the skeptic in particular issues
// findings × rounds requests in a single burst. Against a self-hosted endpoint that is a
// thundering herd: the requests queue in the engine while their own timeout clocks are
// already running, so the tail can abort before it is ever scheduled. A skeptic timeout
// fails open, which means an overloaded endpoint silently turns verification into a no-op —
// worse than not running it, because the run still reports that it verified.
//
// Acquiring before the timer starts is the whole point: waiting for a slot must not consume
// the request's own timeout budget.
export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.limit <= 0) return fn();
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  private release(): void {
    const next = this.queue.shift();
    // Hand the slot straight to the next waiter rather than decrementing and racing.
    if (next) next();
    else this.active--;
  }

  /** For diagnostics and tests. */
  get inFlight(): number {
    return this.active;
  }
  get waiting(): number {
    return this.queue.length;
  }
}
