/**
 * Minimal `Server-Timing` collector for route handlers.
 *
 * `time(name, fn)` runs `fn` and records how long it took (also when it
 * throws). `header()` renders the RFC-compliant `Server-Timing` value —
 * every recorded step plus a `total` measured from creation — so the
 * breakdown shows in DevTools → Network → Timing; `entries()` returns the
 * same numbers for a structured log line (Vercel runtime logs).
 *
 * Steps may nest (e.g. `tx` around `tx.lock`); entries are listed in the
 * order they finished. Values are durations only — never request data — so
 * the header is safe to send on authenticated admin routes.
 */
export interface ServerTimingEntry {
  readonly name: string;
  readonly durMs: number;
}

export interface ServerTiming {
  time<T>(name: string, fn: () => Promise<T>): Promise<T>;
  entries(): ReadonlyArray<ServerTimingEntry>;
  totalMs(): number;
  header(): string;
}

/** Server-Timing metric names are HTTP tokens; keep to a safe subset. */
function toToken(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, '_') || 'step';
}

export function createServerTiming(now: () => number = () => performance.now()): ServerTiming {
  const startedAt = now();
  const recorded: ServerTimingEntry[] = [];
  const round = (ms: number) => Math.round(ms * 10) / 10;
  return {
    async time(name, fn) {
      const t0 = now();
      try {
        return await fn();
      } finally {
        recorded.push({ name: toToken(name), durMs: round(now() - t0) });
      }
    },
    entries: () => [...recorded],
    totalMs: () => round(now() - startedAt),
    header() {
      return [...recorded, { name: 'total', durMs: round(now() - startedAt) }]
        .map((e) => `${e.name};dur=${e.durMs}`)
        .join(', ');
    },
  };
}
