/**
 * T054 — Logger port (F5 Application).
 *
 * Audit 2026-04-25 finding #5: previously `processWebhookEvent`'s tail
 * markProcessed catch block used `console.warn` directly because
 * Application layer cannot import `pino` (Principle III). This port
 * abstracts structured logging behind a Domain-friendly surface so
 * use-cases can emit ops-visibility signals without violating the
 * framework-import boundary.
 *
 * The Infrastructure adapter (`infrastructure/logger/payments-logger.ts`)
 * wraps the project's `pino` instance from `@/lib/logger`. Tests inject
 * a `vi.fn()`-backed `noopLogger` for assertion + isolation.
 *
 * Forbidden fields (PCI SAQ-A + reliability-guardian):
 *   - clientSecret / client_secret
 *   - card.* (PAN / CVV / fingerprint)
 *   - Stripe-Signature header
 *   - raw event payload `data.object`
 * The adapter relies on `pino`'s `redact` config in `src/lib/logger.ts`
 * to enforce these at the lowest level — Application code MUST NOT
 * include any of them in `meta` payloads regardless.
 */
export interface LoggerPort {
  info(message: string, meta?: Readonly<Record<string, unknown>>): void;
  warn(message: string, meta?: Readonly<Record<string, unknown>>): void;
  error(message: string, meta?: Readonly<Record<string, unknown>>): void;
}

/**
 * No-op logger for tests + composition-root fallback. Discards every
 * call. Use when a sub-use-case is invoked without observability
 * wiring (e.g., fast unit tests).
 */
export const noopLogger: LoggerPort = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
