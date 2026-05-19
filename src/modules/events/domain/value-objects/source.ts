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

export const SOURCES = ['eventcreate', 'admin_manual'] as const;
export type Source = (typeof SOURCES)[number];

// F6.1 (Feature 013 · T026 full impl): `'admin_manual'` denotes events
// the admin created via the inline-create modal on /admin/events/import.
// Webhook ingest cannot create events because EventCreate's native API
// is behind their Enterprise tier (project_eventcreate_api_gated memory)
// — making CSV import the primary path AND requiring admins to seed
// events manually. The CSV import path still uses `'eventcreate'` source
// because the CSV file IS an EventCreate-format export.

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
