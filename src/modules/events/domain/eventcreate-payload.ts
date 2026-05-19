/**
 * T023 — Zod schemas for F6 webhook + CSV payloads.
 *
 * Two canonical inbound shapes:
 *   - `EventCreatePayloadV1`  — webhook body, schema-versioned at
 *                                /api/webhooks/eventcreate/v1/[tenantSlug]
 *   - `CsvRowSchema`          — single row in the CSV import format
 *
 * Both schemas use `.passthrough()` on event + attendee sub-objects per
 * FR-011a forward-compat — unknown fields (new EventCreate columns
 * EventCreate adds without notice) are PRESERVED into `metadata` jsonb
 * rather than rejected. Strict-required validation applies to the
 * canonical column set only.
 *
 * `zod` is allowed in the Domain layer (not on the ESLint forbidden list
 * — it's a pure validation library with no framework dependency).
 *
 * Source of truth: data-model.md § 10.
 */
import { z } from 'zod';

/**
 * Inbound webhook body per FR-001 / FR-002. Sourced from Zapier's
 * EventCreate triggers ("New Attendees Registered" + "New Purchase
 * Complete") mapped to a single canonical shape.
 *
 * Defensive caps on every text field:
 *   - `event.name`         ≤ 500 chars
 *   - `event.description`  ≤ 5000 chars
 *   - `event.location`     ≤ 500 chars
 *   - `attendee.email`     ≤ 320 chars (RFC 5321 max)
 *   - `attendee.fullName`  ≤ 200 chars
 *   - `attendee.companyName` ≤ 200 chars
 *   - `attendee.ticketType` ≤ 100 chars
 *
 * These caps protect:
 *   - Database row-size bounds
 *   - PII-redaction log size (truncation defence)
 *   - WCAG-readable rendering in admin tables (no runaway strings)
 */
export const EventCreatePayloadV1 = z.object({
  eventType: z.enum(['attendee.registered', 'purchase.completed']),
  tenantSlug: z.string().min(1).max(63),

  event: z
    .object({
      externalId: z.string().min(1).max(200),
      name: z.string().min(1).max(500),
      description: z.string().max(5000).optional().nullable(),
      startDate: z.string().datetime({ offset: true }),
      endDate: z.string().datetime({ offset: true }).optional().nullable(),
      location: z.string().max(500).optional().nullable(),
      category: z.string().max(100).optional().nullable(),
      isMemberDiscounted: z.boolean().optional(),
      isPartnerBooth: z.boolean().optional(),
      eventCreateUrl: z.string().url().max(1000).optional().nullable(),
    })
    .passthrough(),

  attendee: z
    .object({
      externalId: z.string().min(1).max(200),
      email: z.string().email().max(320),
      fullName: z.string().min(1).max(200),
      companyName: z.string().max(200).optional().nullable(),
      ticketType: z.string().max(100).optional().nullable(),
      ticketPricePaid: z.number().int().nonnegative().optional().nullable(),
      paymentStatus: z
        .enum(['paid', 'pending', 'refunded', 'free', 'waitlisted', 'no_show'])
        .default('paid'),
      registeredAt: z.string().datetime(),
      metadata: z.record(z.unknown()).optional(),
    })
    .passthrough(),
});

export type EventCreatePayloadV1 = z.infer<typeof EventCreatePayloadV1>;

/**
 * Single CSV row schema for the admin bulk-import path (Phase 7 T093/T094).
 *
 * Header column set is the canonical column-mapping target — the importer
 * auto-detects the column order on first row inspection (FR-026) and
 * allows admin remap before commit.
 *
 * `registered_at` defaults to `event_start` if missing (per data-model.md § 10).
 * Application-layer fills the default after parse.
 */
export const CsvRowSchema = z.object({
  event_external_id: z.string().min(1).max(200),
  event_name: z.string().min(1).max(500),
  event_start: z.string().datetime({ offset: true }),
  event_category: z.string().max(100).optional(),
  attendee_email: z.string().email().max(320),
  attendee_name: z.string().min(1).max(200),
  attendee_company: z.string().max(200).optional(),
  /**
   * Optional admin-supplied attendee ID — when present, the use-case
   * passes it through verbatim to `event_registrations.external_id` so
   * webhook-equivalent CSVs preserve their EventCreate attendee IDs.
   * When absent, the use-case derives a synthetic `csv_${rowHash}`
   * value per contracts/csv-import-api.md § "Optional columns".
   * Surfaced in v1.1 per the E1 verification finding (was deferred to
   * F6.1 in the original spec).
   */
  attendee_external_id: z.string().min(1).max(200).optional(),
  ticket_type: z.string().max(100).optional(),
  ticket_price_thb: z.coerce.number().int().nonnegative().optional(),
  payment_status: z
    .enum(['paid', 'pending', 'refunded', 'free', 'waitlisted', 'no_show'])
    .default('paid'),
  registered_at: z.string().datetime().optional(),
  // NB: `is_partner_benefit` + `is_cultural_event` CSV columns are
  // intentionally DROPPED in v1 (E2 verification finding deferral).
  // These fields are admin-toggle-controlled per FR-019 — surfacing
  // them from CSV would create dual-source-of-truth ambiguity (CSV
  // value vs. admin toggle state). v1.1 may add a one-time-initial
  // semantic (apply CSV value ONLY on first event INSERT, never on
  // ON CONFLICT UPDATE) if a real tenant ask emerges.
});

export type CsvRow = z.infer<typeof CsvRowSchema>;

/**
 * Canonical-key set that MUST be stripped from `metadata` jsonb to
 * prevent collision with typed columns (data-model.md § 1.1 invariant).
 * Used by the webhook upsert path before persisting `events.metadata`.
 */
export const EVENT_CANONICAL_KEYS = new Set<string>([
  'externalId',
  'name',
  'description',
  'startDate',
  'endDate',
  'location',
  'category',
  'isMemberDiscounted',
  'isPartnerBooth',
  'eventCreateUrl',
]);

export const ATTENDEE_CANONICAL_KEYS = new Set<string>([
  'externalId',
  'email',
  'fullName',
  'companyName',
  'ticketType',
  'ticketPricePaid',
  'paymentStatus',
  'registeredAt',
  'metadata',
]);

/**
 * Strip canonical keys from a `.passthrough()`-parsed sub-object so what
 * remains is the FR-011a forward-compat payload destined for the
 * `metadata jsonb` column. Pure function — no side effects.
 */
export function extractMetadata(
  parsed: Record<string, unknown>,
  canonicalKeys: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (!canonicalKeys.has(k)) out[k] = v;
  }
  return out;
}
