// Process-wide in-flight cap for CLI spawns. HTTP calls never acquire it.
// Queue wait does not start the per-call timeout. Abort while queued throws
// AbortError and does not spawn.

export function abortException(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

interface Waiter {
  signal: AbortSignal | undefined;
  settled: boolean;
  succeed: () => void;
  fail: (err: unknown) => void;
}

export class CliGate {
  readonly limit: number;
  #inFlight = 0;
  #queue: Waiter[] = [];

  constructor(maxInFlight: number) {
    if (!Number.isInteger(maxInFlight) || maxInFlight < 1) {
      throw new Error(`cliMaxInFlight must be an integer >= 1, got ${String(maxInFlight)}`);
    }
    this.limit = maxInFlight;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw abortException();
    }
    if (this.#inFlight < this.limit) {
      this.#inFlight += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        settled: false,
        succeed: () => {
          if (waiter.settled) return;
          waiter.settled = true;
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        fail: (err: unknown) => {
          if (waiter.settled) return;
          waiter.settled = true;
          signal?.removeEventListener("abort", onAbort);
          reject(
            err instanceof Error || err instanceof DOMException ? err : new Error(String(err)),
          );
        },
      };
      const onAbort = () => {
        const idx = this.#queue.indexOf(waiter);
        if (idx >= 0) this.#queue.splice(idx, 1);
        waiter.fail(abortException());
      };
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.#queue.push(waiter);
    });
  }

  release(): void {
    if (this.#inFlight === 0) return;
    while (this.#queue.length > 0) {
      const next = this.#queue.shift();
      if (!next || next.settled) continue;
      if (next.signal?.aborted) {
        next.fail(abortException());
        continue;
      }
      next.succeed();
      return;
    }
    this.#inFlight -= 1;
  }
}
