/**
 * T017 — `Source` value object (F6).
 *
 * Identifies the upstream system that produced the event/registration data.
 *
 *   - `eventcreate` — Zapier-fed EventCreate webhook OR CSV import using the
 *                     same canonical column set. Single source supported in v1
 *                     (FR-001 schema-versioned path `/api/webhooks/eventcreate/v1/...`).
 *
 * Forward-compat: the column-level CHECK constraint enforces only
 * `'eventcreate'` today, but the shape of the discriminator + the
 * extensibility hook in `tenant_webhook_configs.source` means adding e.g.
 * `'eventbrite'` would require only a migration + an additional union
 * member here.
 *
 * Pure TypeScript — Constitution Principle III.
 */

export const SOURCES = ['eventcreate'] as const;
export type Source = (typeof SOURCES)[number];

export function isSource(value: unknown): value is Source {
  return (
    typeof value === 'string' && (SOURCES as readonly string[]).includes(value)
  );
}

/**
 * Idempotency-receipt sources — distinct from the event-source enum because
 * webhook vs. CSV have different idempotency keys (X-Request-ID vs.
 * SHA-256 row hash) per data-model.md § 1.4.
 */
export const IDEMPOTENCY_SOURCES = [
  'eventcreate_webhook',
  'eventcreate_csv',
] as const;
export type IdempotencySource = (typeof IDEMPOTENCY_SOURCES)[number];

export function isIdempotencySource(
  value: unknown,
): value is IdempotencySource {
  return (
    typeof value === 'string' &&
    (IDEMPOTENCY_SOURCES as readonly string[]).includes(value)
  );
}
