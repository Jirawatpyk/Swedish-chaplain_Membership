/**
 * E2E seed/reset helper for F6 EventCreate integration.
 *
 * Provides two operations used by F6 Playwright specs:
 *
 *   1. `resetEventcreateState(tenantSlug)` — wipes the F6 surface for a
 *      tenant so wizard specs start from a "fresh tenant" state:
 *        • deletes `tenant_webhook_configs` row
 *        • deletes all `events` + `event_registrations` rows for tenant
 *        • deletes `eventcreate_idempotency_receipts` rows for tenant
 *      Audit-log entries are LEFT IN PLACE (forensic-trail integrity per
 *      Constitution Principle I — never DELETE from `audit_log`); they
 *      are filtered out at the recent-deliveries panel level when stale.
 *
 *   2. `seedKnownWebhookSecret(tenantSlug, secret)` — UPSERTs a webhook
 *      config row with a CALLER-KNOWN secret so webhook-ingest spec
 *      (Phase 3 US1 AS1-AS5) can sign payloads. The secret should be
 *      strong (≥32 bytes base64url) — production verifier still
 *      enforces 64-char hex signature shape + timing-safe compare.
 *
 * Both operations connect via `neondb_owner` (bypasses RLS) — same
 * pattern as `tests/e2e/helpers/renewals-seed.ts` and `scripts/seed-*`.
 *
 * No-op when `DATABASE_URL` is missing (returns early with warning).
 */
import postgres from 'postgres';
import { z } from 'zod';

const TENANT_ID = process.env.E2E_TENANT_SLUG ?? process.env.TENANT_SLUG ?? 'swecham';

/**
 * Default fixture secret used by webhook-ingest spec. Hardcoded so the
 * spec + seed are byte-aligned without an extra env var. Strong enough
 * to satisfy `WebhookSecret` brand validation (≥40 chars).
 */
export const F6_E2E_FIXTURE_SECRET =
  'whsec_F6E2EFixtureSecretForLocalAndCIRuns2026';

interface SeedClient {
  sql: ReturnType<typeof postgres>;
  end: () => Promise<void>;
}

function openClient(): SeedClient | null {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.warn('[e2e seed F6] skipped — DATABASE_URL missing');
    return null;
  }
  const sql = postgres(dbUrl, { ssl: 'require', max: 1 });
  return { sql, end: () => sql.end() };
}

/**
 * Wipe F6 state for a tenant. Use in `test.beforeAll` of wizard +
 * webhook-ingest specs so each run starts from a known empty state.
 */
export async function resetEventcreateState(
  tenantSlug: string = TENANT_ID,
): Promise<void> {
  const client = openClient();
  if (!client) return;
  try {
    // Order matters: child FKs first.
    //   - event_registrations FK → events
    //   - csv_import_records FK → events (added F6 Phase 7)
    //   - eventcreate_idempotency_receipts: independent of events
    //   - tenant_webhook_configs last so the verifier reads it on next hit
    await client.sql`DELETE FROM event_registrations WHERE tenant_id = ${tenantSlug}`;
    await client.sql`DELETE FROM csv_import_records WHERE tenant_id = ${tenantSlug}`;
    await client.sql`DELETE FROM events WHERE tenant_id = ${tenantSlug}`;
    await client.sql`DELETE FROM eventcreate_idempotency_receipts WHERE tenant_id = ${tenantSlug}`;
    await client.sql`DELETE FROM tenant_webhook_configs WHERE tenant_id = ${tenantSlug}`;
  } finally {
    await client.end();
  }
}

/**
 * UPSERT a webhook config row with a known secret. Used by webhook-
 * ingest spec to pre-seed the tenant so signed POSTs verify. Caller
 * passes the secret it will use to sign — keeps spec + seed in sync.
 */
export async function seedKnownWebhookSecret(
  tenantSlug: string = TENANT_ID,
  secret: string = F6_E2E_FIXTURE_SECRET,
): Promise<void> {
  const client = openClient();
  if (!client) return;
  try {
    await client.sql`
      INSERT INTO tenant_webhook_configs
        (tenant_id, source, webhook_secret_active, enabled, created_at)
      VALUES
        (${tenantSlug}, 'eventcreate', ${secret}, TRUE, NOW())
      ON CONFLICT (tenant_id, source) DO UPDATE SET
        webhook_secret_active = ${secret},
        webhook_secret_grace = NULL,
        grace_rotated_at = NULL,
        enabled = TRUE,
        last_rotated_at = NOW()
    `;
  } finally {
    await client.end();
  }
}

/**
 * Convenience: full reset then seed known secret. Used by webhook-
 * ingest spec which needs both a clean slate AND a known secret.
 */
export async function resetAndSeedKnownSecret(
  tenantSlug: string = TENANT_ID,
  secret: string = F6_E2E_FIXTURE_SECRET,
): Promise<void> {
  await resetEventcreateState(tenantSlug);
  await seedKnownWebhookSecret(tenantSlug, secret);
}

/**
 * T100 (F6 Phase 8 / US7 / FR-008) — seed a "post-rotation" webhook
 * config so AS2 (12h grace verifies) + AS3 (25h grace rejects) can run
 * without sleeping the test runner for hours.
 *
 * Writes a tenant_webhook_configs row with:
 *   - webhook_secret_active = `newActiveSecret`   (current secret)
 *   - webhook_secret_grace  = `oldSecret`         (the deprecated key)
 *   - grace_rotated_at      = NOW() - INTERVAL `${ageHours} hours`
 *   - last_rotated_at       = NOW() - INTERVAL `${ageHours} hours`
 *
 * The DB clock is used (not the JS runner clock) — verifier compares
 * `now()` against `grace_rotated_at`, both server-side, so DB time is
 * the authoritative source.
 *
 * Bypasses RLS via neondb_owner connection (same pattern as
 * `resetEventcreateState`).
 */
export async function seedRotatedWebhookState(
  tenantSlug: string = TENANT_ID,
  options: {
    readonly oldSecret: string;
    readonly newActiveSecret: string;
    readonly ageHours: number;
  },
): Promise<void> {
  // PR-review code-review M-4 (2026-05-16): guard against NaN/Infinity
  // because postgres-js binds `number` as a parameter and the resulting
  // INTERVAL cast on `'NaN hours'::INTERVAL` errors at the DB with a
  // confusing message far from the helper site.
  if (!Number.isFinite(options.ageHours)) {
    throw new Error(
      `seedRotatedWebhookState: ageHours must be a finite number; got ${String(options.ageHours)}`,
    );
  }
  const client = openClient();
  if (!client) return;
  try {
    await client.sql`
      INSERT INTO tenant_webhook_configs
        (tenant_id, source, webhook_secret_active, webhook_secret_grace,
         grace_rotated_at, last_rotated_at, enabled, created_at)
      VALUES
        (${tenantSlug}, 'eventcreate',
         ${options.newActiveSecret}, ${options.oldSecret},
         NOW() - (${options.ageHours}::TEXT || ' hours')::INTERVAL,
         NOW() - (${options.ageHours}::TEXT || ' hours')::INTERVAL,
         TRUE, NOW())
      ON CONFLICT (tenant_id, source) DO UPDATE SET
        webhook_secret_active = ${options.newActiveSecret},
        webhook_secret_grace = ${options.oldSecret},
        grace_rotated_at = NOW() - (${options.ageHours}::TEXT || ' hours')::INTERVAL,
        last_rotated_at = NOW() - (${options.ageHours}::TEXT || ' hours')::INTERVAL,
        enabled = TRUE
    `;
  } finally {
    await client.end();
  }
}

/**
 * PR-review type-design CRITICAL fix (2026-05-16): runtime-validated
 * shape for an audit_log row. Replaces the previous `as { ... }` cast
 * which silently passed `tsc` if migrations renamed columns. With
 * this schema, a column rename / view change fails at the seam
 * (`AuditRowSchema.parse(rows[0])`) with a precise Zod error message
 * rather than `undefined` at the test's assertion site.
 */
const AuditRowSchema = z.object({
  event_type: z.string(),
  tenant_id: z.string(),
  request_id: z.string(),
  summary: z.string(),
  payload: z.unknown(),
});

export type AuditRow = z.infer<typeof AuditRowSchema>;

/**
 * T100 — query the audit_log for a webhook receipt outcome row tied
 * to a specific `requestId`. Used by secret-rotation E2E to assert
 * the grace-used / signature-rejected emission.
 *
 * Polls up to `timeoutMs` because the F6 receiver emits audit rows
 * via `safeEmitStandalone` in a SEPARATE transaction (research.md
 * R6) — the audit row may commit slightly after the HTTP response.
 *
 * Returns the most recent matching row, or `null` if the poll window
 * expires.
 *
 * PR-review silent-failure H-2 fix (2026-05-16): throws when
 * `DATABASE_URL` is unset rather than silently returning `null`. The
 * old behaviour conflated "DB unavailable" with "audit row never
 * emitted", letting absence-assertions (e.g., AS3) pass for the wrong
 * reason on a misconfigured runner. E2E tests upstream of this helper
 * are already guarded by `test.skip(!E2E_ADMIN_EMAIL || ...)` — when
 * those guards pass, `DATABASE_URL` is expected and a missing value
 * is a setup error worth surfacing loudly.
 */
export async function queryAuditEvent(
  tenantSlug: string,
  eventType: string,
  requestId: string,
  timeoutMs: number = 2000,
): Promise<AuditRow | null> {
  const client = openClient();
  if (!client) {
    throw new Error(
      'queryAuditEvent requires DATABASE_URL. ' +
        'This helper is called from E2E tests that are gated on ' +
        'E2E_ADMIN_EMAIL/E2E_ADMIN_PASSWORD; if those env vars are ' +
        'set, DATABASE_URL must be set too.',
    );
  }
  const startedAt = Date.now();
  try {
    for (;;) {
      const rows = await client.sql`
        SELECT event_type, tenant_id, request_id, summary, payload
        FROM audit_log
        WHERE tenant_id = ${tenantSlug}
          AND event_type = ${eventType}
          AND request_id = ${requestId}
        ORDER BY timestamp DESC
        LIMIT 1
      `;
      if (rows.length > 0) {
        return AuditRowSchema.parse(rows[0]);
      }
      if (Date.now() - startedAt > timeoutMs) return null;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    await client.end();
  }
}

// ===========================================================================
// `seedF6Events` — seed real events + registrations for the admin LIST
// + DETAIL E2E suites (`events-list-and-detail.spec.ts` US2 AS1-AS5).
//
// Distinct from the webhook-ingest seed above:
//   • That path seeds ONLY the webhook config + a known secret so the
//     webhook-ingest spec can exercise the public POST endpoint with
//     signed payloads. No persisted event/registration rows.
//   • This path bypasses the webhook entirely and inserts events +
//     registrations directly into the DB, which is what the admin
//     /admin/events list page reads. The test-webhook button (Phase 5
//     T072) cannot produce these rows — it short-circuits at the
//     receiver per spec round-2 P8 (`__test_webhook__` sentinel).
//
// Tenant: `E2E_TENANT_SLUG` (default `swecham`) — matches the admin
// session helper's resolved tenant.
//
// Idempotent — every INSERT uses ON CONFLICT DO UPDATE keyed on the
// deterministic sentinel `external_id` so re-runs converge on the same
// shape. UUIDs are DB-generated; cross-run stable lookup uses
// `external_id`.
// ===========================================================================

// Deterministic sentinels so the seed is idempotent across runs.
// All `e2e-f6-event-*` and `e2e-f6-reg-*` rows are owned by the e2e
// fixture and safe to UPSERT.
const EXT_EVENT_PB = 'e2e-f6-event-partner-benefit';
const EXT_EVENT_CULTURAL = 'e2e-f6-event-cultural';
const EXT_EVENT_ARCHIVED = 'e2e-f6-event-archived';

// Sentinel external_ids — every fixture row is keyed off these so
// re-running the seed converges on the same shape.
//
// Coverage matrix (all badge variants):
//   MatchStatusBadge  — member_contact / member_domain / member_fuzzy /
//                       non_member / unmatched (5 variants)
//   QuotaEffectBadge  — Partnership benefit (counted_against_partnership=true)
//                       / Cultural event (counted_against_cultural_quota=true)
//                       / Over quota (isOverQuota auto-computed: non-quota
//                       match-type + flagged event) / Not counted
//                       (all 3 flags false; matched-but-over-allotment scenario)
//   PaymentStatusBadge — paid / pending / refunded / free
const EXT_REG_E1_MEMBER_CONTACT = 'e2e-f6-reg-e1-member-contact';   // → Partnership benefit
const EXT_REG_E1_MEMBER_DOMAIN_COUNTED = 'e2e-f6-reg-e1-member-domain-counted'; // → Partnership benefit
const EXT_REG_E1_MEMBER_DOMAIN_NOT_COUNTED = 'e2e-f6-reg-e1-member-domain-not-counted'; // → Not counted (matched + quota exhausted)
const EXT_REG_E1_NON_1 = 'e2e-f6-reg-e1-nonmember-1';   // → Over quota
const EXT_REG_E1_NON_2 = 'e2e-f6-reg-e1-nonmember-2';   // → Over quota (pending payment)
const EXT_REG_E1_UNMATCHED = 'e2e-f6-reg-e1-unmatched'; // → Over quota (refunded — FR-018)
const EXT_REG_E2_MEMBER_FUZZY = 'e2e-f6-reg-e2-member-fuzzy'; // → Cultural event
const EXT_REG_E2_NON = 'e2e-f6-reg-e2-nonmember';       // → Over quota
const EXT_REG_E2_UNMATCHED_1 = 'e2e-f6-reg-e2-unmatched-1'; // → Over quota
const EXT_REG_E2_UNMATCHED_2 = 'e2e-f6-reg-e2-unmatched-2'; // → Over quota

export interface SeedEventsResult {
  readonly tenantId: string;
  readonly partnerBenefitEventId: string;
  readonly culturalEventId: string;
  readonly archivedEventId: string;
}

export async function seedF6Events(
  tenantSlug: string = TENANT_ID,
): Promise<SeedEventsResult | null> {
  const client = openClient();
  if (!client) return null;
  try {
    // 1. Webhook config row — `enabled=true` + `last_received_at=NOW()`
    //    so `emptyStateContext.{integrationConfigured,everReceivedDelivery}
    //    = true` and the list page renders the table path (not an
    //    empty-state variant). UPSERT keyed on (tenant_id, source).
    await client.sql`
      INSERT INTO tenant_webhook_configs (
        tenant_id, source,
        webhook_secret_active, webhook_secret_grace, grace_rotated_at,
        enabled, last_received_at
      ) VALUES (
        ${tenantSlug}, 'eventcreate',
        ${F6_E2E_FIXTURE_SECRET}, NULL, NULL,
        TRUE, NOW()
      )
      ON CONFLICT (tenant_id, source) DO UPDATE
        SET enabled = TRUE,
            last_received_at = NOW(),
            webhook_secret_active = EXCLUDED.webhook_secret_active
    `;

    // 2. Events (3 rows) — distinct `start_date` so AS1's default
    //    `start_date DESC` sort produces a stable order. One row each:
    //      • partner-benefit active (eventcreate_url set for AS3 deep link)
    //      • cultural active (separate row for AS1 sort verification)
    //      • archived (AS5 variant c "Show archived" toggle target)
    const eventRows = await client.sql<
      Array<{ event_id: string; external_id: string }>
    >`
      INSERT INTO events (
        tenant_id, source, external_id,
        name, description, start_date, end_date, location, category,
        eventcreate_url,
        is_partner_benefit, is_cultural_event, archived_at, metadata
      ) VALUES
        (${tenantSlug}, 'eventcreate', ${EXT_EVENT_PB},
         'E2E F6 Partner Benefit Event', 'Seeded by tests/e2e/helpers/eventcreate-seed.ts',
         '2026-06-21T18:00:00Z', '2026-06-21T22:00:00Z',
         'Singapore', 'networking',
         'https://events.example/e2e-f6-partner-benefit',
         TRUE, FALSE, NULL, '{}'::jsonb),
        (${tenantSlug}, 'eventcreate', ${EXT_EVENT_CULTURAL},
         'E2E F6 Cultural Event', 'Seeded by tests/e2e/helpers/eventcreate-seed.ts',
         '2026-05-10T18:00:00Z', '2026-05-10T22:00:00Z',
         'Singapore', 'cultural',
         'https://events.example/e2e-f6-cultural',
         FALSE, TRUE, NULL, '{}'::jsonb),
        (${tenantSlug}, 'eventcreate', ${EXT_EVENT_ARCHIVED},
         'E2E F6 Archived Event', 'Seeded by tests/e2e/helpers/eventcreate-seed.ts',
         '2026-04-01T18:00:00Z', '2026-04-01T22:00:00Z',
         'Singapore', 'networking',
         'https://events.example/e2e-f6-archived',
         FALSE, FALSE, NOW(), '{}'::jsonb)
      ON CONFLICT (tenant_id, source, external_id) DO UPDATE
        SET name = EXCLUDED.name,
            description = EXCLUDED.description,
            start_date = EXCLUDED.start_date,
            end_date = EXCLUDED.end_date,
            location = EXCLUDED.location,
            category = EXCLUDED.category,
            eventcreate_url = EXCLUDED.eventcreate_url,
            is_partner_benefit = EXCLUDED.is_partner_benefit,
            is_cultural_event = EXCLUDED.is_cultural_event,
            archived_at = EXCLUDED.archived_at,
            last_updated_at = NOW()
      RETURNING event_id::text AS event_id, external_id
    `;

    const byExt = new Map(eventRows.map((r) => [r.external_id, r.event_id]));
    const partnerBenefitEventId = byExt.get(EXT_EVENT_PB);
    const culturalEventId = byExt.get(EXT_EVENT_CULTURAL);
    const archivedEventId = byExt.get(EXT_EVENT_ARCHIVED);
    if (!partnerBenefitEventId || !culturalEventId || !archivedEventId) {
      throw new Error('[e2e seed F6] events upsert returned <3 rows');
    }

    // 3a. Lookup the existing e2e-member's member_id + primary contact_id
    //    so the matched registrations below can FK-reference a real F3
    //    row. The e2e-member is provisioned by `scripts/seed-e2e-user.ts`
    //    and resolved here via E2E_MEMBER_EMAIL — same pattern as
    //    F8 renewals-seed.ts line 42-53.
    //
    //    If the lookup fails (env missing, member not seeded, RLS quirk),
    //    fall back to non_member-only registrations so the seed still
    //    succeeds — the test won't get a >0% match rate but the table
    //    still renders.
    const memberEmail = process.env.E2E_MEMBER_EMAIL;
    let matchedMemberId: string | null = null;
    let matchedContactId: string | null = null;
    if (memberEmail) {
      const memberRows = await client.sql<
        Array<{ member_id: string; contact_id: string | null }>
      >`
        SELECT m.member_id::text AS member_id,
               pc.contact_id::text AS contact_id
        FROM users u
        JOIN contacts c
          ON c.linked_user_id = u.id AND c.tenant_id = ${tenantSlug}
        JOIN members m
          ON m.member_id = c.member_id AND m.tenant_id = ${tenantSlug}
        LEFT JOIN contacts pc
          ON pc.member_id = m.member_id
         AND pc.tenant_id = ${tenantSlug}
         AND pc.is_primary = TRUE
         AND pc.removed_at IS NULL
        WHERE u.email = ${memberEmail}
        LIMIT 1
      `;
      if (memberRows[0]) {
        matchedMemberId = memberRows[0].member_id;
        matchedContactId = memberRows[0].contact_id;
      }
    }

    // 3b. Non-member subset of registrations — 6 rows, all
    //    `match_type IN ('non_member','unmatched')`. On a flagged
    //    partner-benefit/cultural event the use-case derives
    //    `isOverQuota=true` for these rows automatically → renders
    //    "Over quota" badge. Payment-status spread covers the 4-value
    //    union: paid / pending / refunded / free.
    //
    //    CHECK constraint `event_registrations_non_member_no_quota`
    //    (migration 0128 + tightened 0136) requires non_member/unmatched
    //    rows to have NULL matched_member_id + NULL matched_contact_id +
    //    counted_against_partnership=FALSE + counted_against_cultural_quota
    //    =FALSE. The UPDATE branch refreshes mutable fields on re-run.
    await client.sql`
      INSERT INTO event_registrations (
        tenant_id, event_id, external_id,
        attendee_email, attendee_name, attendee_company,
        match_type, matched_member_id, matched_contact_id,
        ticket_type, ticket_price_thb, payment_status,
        counted_against_partnership, counted_against_cultural_quota,
        metadata, registered_at
      ) VALUES
        (${tenantSlug}, ${partnerBenefitEventId}, ${EXT_REG_E1_NON_1},
         'alice@e2e-f6-outsider.example', 'Alice Outsider', 'Outsider Co. Ltd',
         'non_member', NULL, NULL,
         'Non-member ticket', 50000, 'paid',
         FALSE, FALSE, '{}'::jsonb, '2026-06-01T10:00:00Z'),
        (${tenantSlug}, ${partnerBenefitEventId}, ${EXT_REG_E1_NON_2},
         'bob@e2e-f6-outsider.example', 'Bob Outsider', 'Outsider Co. Ltd',
         'non_member', NULL, NULL,
         'Non-member ticket', 50000, 'pending',
         FALSE, FALSE, '{}'::jsonb, '2026-06-01T11:00:00Z'),
        (${tenantSlug}, ${partnerBenefitEventId}, ${EXT_REG_E1_UNMATCHED},
         'carol@e2e-f6-ambiguous.example', 'Carol Ambiguous', 'Ambig Holdings',
         'unmatched', NULL, NULL,
         'Non-member ticket', 50000, 'refunded',
         FALSE, FALSE, '{}'::jsonb, '2026-06-01T12:00:00Z'),
        (${tenantSlug}, ${culturalEventId}, ${EXT_REG_E2_NON},
         'dan@e2e-f6-outsider.example', 'Dan Outsider', 'Outsider Co. Ltd',
         'non_member', NULL, NULL,
         'Non-member ticket', 30000, 'paid',
         FALSE, FALSE, '{}'::jsonb, '2026-04-20T10:00:00Z'),
        (${tenantSlug}, ${culturalEventId}, ${EXT_REG_E2_UNMATCHED_1},
         'eve@e2e-f6-ambiguous.example', 'Eve Ambiguous', 'Ambig Holdings',
         'unmatched', NULL, NULL,
         NULL, NULL, 'paid',
         FALSE, FALSE, '{}'::jsonb, '2026-04-20T11:00:00Z'),
        (${tenantSlug}, ${culturalEventId}, ${EXT_REG_E2_UNMATCHED_2},
         'frank@e2e-f6-ambiguous.example', 'Frank Ambiguous', 'Ambig Holdings',
         'unmatched', NULL, NULL,
         NULL, NULL, 'paid',
         FALSE, FALSE, '{}'::jsonb, '2026-04-20T12:00:00Z')
      ON CONFLICT (tenant_id, event_id, external_id) DO UPDATE
        SET attendee_email = EXCLUDED.attendee_email,
            attendee_name = EXCLUDED.attendee_name,
            attendee_company = EXCLUDED.attendee_company,
            match_type = EXCLUDED.match_type,
            ticket_type = EXCLUDED.ticket_type,
            ticket_price_thb = EXCLUDED.ticket_price_thb,
            payment_status = EXCLUDED.payment_status,
            counted_against_partnership = EXCLUDED.counted_against_partnership,
            counted_against_cultural_quota = EXCLUDED.counted_against_cultural_quota,
            registered_at = EXCLUDED.registered_at
    `;

    // 3c. Matched registrations — only when e2e-member resolved.
    //    Three rows seed all 3 matched-type variants so the match-cascade
    //    badge rendering is exercised across the AS2 attendee table.
    //    `memberEmail` is guaranteed non-null inside the
    //    `matchedMemberId` branch (matchedMemberId only assigns when
    //    memberEmail is truthy at the lookup site), but TS does not
    //    narrow across the closure boundary — local `const` rebinding
    //    keeps the type-checker happy.
    let matchedCount = 0;
    if (matchedMemberId && memberEmail) {
      const matchedMemberEmail = memberEmail;
      // member_contact requires both member_id + contact_id; fall back
      // to member_domain (which only needs member_id) when the e2e-member
      // has no primary contact (rare but tolerated).
      // E1 member_contact + counted_against_partnership=TRUE
      //   → MatchStatusBadge "member_contact" + QuotaEffectBadge
      //     "Partnership benefit" + PaymentStatusBadge "free".
      //   Requires both member_id + contact_id (FK).
      const e1ContactRow = matchedContactId
        ? client.sql`
            INSERT INTO event_registrations (
              tenant_id, event_id, external_id,
              attendee_email, attendee_name, attendee_company,
              match_type, matched_member_id, matched_contact_id,
              ticket_type, ticket_price_thb, payment_status,
              counted_against_partnership, counted_against_cultural_quota,
              metadata, registered_at
            ) VALUES
              (${tenantSlug}, ${partnerBenefitEventId}, ${EXT_REG_E1_MEMBER_CONTACT},
               ${matchedMemberEmail}, 'E2E Member', 'E2E Member Co.',
               'member_contact', ${matchedMemberId}::uuid, ${matchedContactId}::uuid,
               'Member ticket', 0, 'free',
               TRUE, FALSE, '{}'::jsonb, '2026-06-01T09:00:00Z')
            ON CONFLICT (tenant_id, event_id, external_id) DO UPDATE
              SET match_type = EXCLUDED.match_type,
                  matched_member_id = EXCLUDED.matched_member_id,
                  matched_contact_id = EXCLUDED.matched_contact_id,
                  payment_status = EXCLUDED.payment_status,
                  counted_against_partnership = EXCLUDED.counted_against_partnership,
                  counted_against_cultural_quota = EXCLUDED.counted_against_cultural_quota
          `
        : null;
      if (e1ContactRow) {
        await e1ContactRow;
        matchedCount++;
      }
      // Remaining matched rows — splits into 3 distinct quota-effect
      // states so all QuotaEffectBadge variants render at the same
      // event-detail view:
      //   E1 member_domain (counted=TRUE) → "Partnership benefit"
      //   E1 member_domain (counted=FALSE) → "Not counted"
      //      — matched member but quota exhausted / allotment unused;
      //      this is the legitimate FR-017 "matched-but-not-counted"
      //      state that's hardest to reason about, so seed it explicitly.
      //   E2 member_fuzzy (cultural-quota counted) → "Cultural event"
      await client.sql`
        INSERT INTO event_registrations (
          tenant_id, event_id, external_id,
          attendee_email, attendee_name, attendee_company,
          match_type, matched_member_id, matched_contact_id,
          ticket_type, ticket_price_thb, payment_status,
          counted_against_partnership, counted_against_cultural_quota,
          metadata, registered_at
        ) VALUES
          (${tenantSlug}, ${partnerBenefitEventId}, ${EXT_REG_E1_MEMBER_DOMAIN_COUNTED},
           'colleague@e2e-member-domain.example', 'E2E Colleague', 'E2E Member Co.',
           'member_domain', ${matchedMemberId}::uuid, NULL,
           'Member ticket', 0, 'free',
           TRUE, FALSE, '{}'::jsonb, '2026-06-01T08:30:00Z'),
          (${tenantSlug}, ${partnerBenefitEventId}, ${EXT_REG_E1_MEMBER_DOMAIN_NOT_COUNTED},
           'alumna@e2e-member-domain.example', 'E2E Alumna', 'E2E Member Co.',
           'member_domain', ${matchedMemberId}::uuid, NULL,
           'Member ticket', 0, 'free',
           FALSE, FALSE, '{}'::jsonb, '2026-06-01T08:45:00Z'),
          (${tenantSlug}, ${culturalEventId}, ${EXT_REG_E2_MEMBER_FUZZY},
           'fuzzy@e2e-member-fuzzy.example', 'E2E Fuzzy Match', 'E2E Membr Co.',
           'member_fuzzy', ${matchedMemberId}::uuid, NULL,
           'Member ticket', 0, 'free',
           FALSE, TRUE, '{}'::jsonb, '2026-04-20T09:00:00Z')
        ON CONFLICT (tenant_id, event_id, external_id) DO UPDATE
          SET match_type = EXCLUDED.match_type,
              matched_member_id = EXCLUDED.matched_member_id,
              matched_contact_id = EXCLUDED.matched_contact_id,
              payment_status = EXCLUDED.payment_status,
              counted_against_partnership = EXCLUDED.counted_against_partnership,
              counted_against_cultural_quota = EXCLUDED.counted_against_cultural_quota
      `;
      matchedCount += 3;
    }

    console.log(
      `[e2e seed F6] OK — tenant=${tenantSlug} events=3 registrations=${6 + matchedCount} ` +
        `(3 non_member + 3 unmatched + ${matchedCount} matched) ` +
        `— badges covered: Partnership benefit + Cultural event + Over quota + Not counted ` +
        `— payment statuses: paid + pending + refunded + free` +
        `${matchedMemberId ? '' : ' — matched rows skipped: e2e-member not resolved'}`,
    );

    return {
      tenantId: tenantSlug,
      partnerBenefitEventId,
      culturalEventId,
      archivedEventId,
    };
  } finally {
    await client.end();
  }
}

// ===========================================================================
// `seedF6RelinkFixture` — seeds a dedicated event + 3 registrations for the
// Phase 9 / US6 relink-attendee E2E spec. Distinct from `seedF6Events` so
// the relink test owns its rows and does not perturb the list/detail spec's
// match-rate expectations.
//
// The three registrations cover US6 AS1, AS2, and the FR-014 pseudonymised
// disallowed branch (round-2 R4):
//   1. non_member row — admin relinks to E2E_MEMBER (AS1).
//   2. matched + counted member-contact row — admin relinks to a different
//      member; verifies the row's match badge updates (AS2; the quota
//      credit-back math is owned by the live-Neon integration test).
//   3. row with `pii_pseudonymised_at = NOW()` — the inline disallowed
//      message replaces the Relink CTA per FR-014.
//
// Returns the IDs the spec needs to drive precise selectors.
// ===========================================================================

const EXT_EVENT_RELINK = 'e2e-f6-event-relink';
const EXT_REG_RELINK_NONMEMBER = 'e2e-f6-reg-relink-nonmember';
const EXT_REG_RELINK_COUNTED = 'e2e-f6-reg-relink-counted';
const EXT_REG_RELINK_PSEUDONYMISED = 'e2e-f6-reg-relink-pseudonymised';

export interface SeedRelinkFixtureResult {
  readonly tenantId: string;
  readonly eventId: string;
  readonly nonMemberRegistrationId: string;
  readonly countedRegistrationId: string;
  readonly pseudonymisedRegistrationId: string;
  /**
   * E2E member resolved from `E2E_MEMBER_EMAIL`. The relink E2E uses this
   * to search the picker for a known target member. `null` when the env
   * var is missing — the spec gates with `test.skip` in that case.
   */
  readonly e2eMemberId: string | null;
  readonly e2eMemberCompany: string | null;
  /**
   * Round-1 test-M6 closure — distinct synthetic "Relink Target" member
   * so the AS2 E2E can exercise the **A→B** transition (spec.md:146)
   * instead of the trivial A→A noop short-circuit. Created with a
   * deterministic UUID + company name keyed off `seedRelinkTargetMember`
   * so picker queries can find it reliably.
   */
  readonly relinkTargetMemberId: string;
  readonly relinkTargetCompany: string;
}

export async function seedF6RelinkFixture(
  tenantSlug: string = TENANT_ID,
): Promise<SeedRelinkFixtureResult | null> {
  const client = openClient();
  if (!client) return null;
  try {
    // 1. Webhook config — enabled so /admin/events/[id] passes the
    //    `everReceivedDelivery` guard. Reusing the F6 fixture secret keeps
    //    the integration-test pre-condition aligned with seedF6Events.
    await client.sql`
      INSERT INTO tenant_webhook_configs (
        tenant_id, source,
        webhook_secret_active, webhook_secret_grace, grace_rotated_at,
        enabled, last_received_at
      ) VALUES (
        ${tenantSlug}, 'eventcreate',
        ${F6_E2E_FIXTURE_SECRET}, NULL, NULL,
        TRUE, NOW()
      )
      ON CONFLICT (tenant_id, source) DO UPDATE
        SET enabled = TRUE,
            last_received_at = NOW(),
            webhook_secret_active = EXCLUDED.webhook_secret_active
    `;

    // 2. Dedicated relink event — partner_benefit=true so AS2's
    //    member-contact row carries a counted partnership flag.
    const eventRows = await client.sql<Array<{ event_id: string }>>`
      INSERT INTO events (
        tenant_id, source, external_id,
        name, description, start_date, end_date, location, category,
        eventcreate_url,
        is_partner_benefit, is_cultural_event, archived_at, metadata
      ) VALUES (
        ${tenantSlug}, 'eventcreate', ${EXT_EVENT_RELINK},
        'E2E F6 Relink Fixture Event',
        'Seeded by tests/e2e/helpers/eventcreate-seed.ts (seedF6RelinkFixture)',
        '2026-07-15T18:00:00Z', '2026-07-15T22:00:00Z',
        'Bangkok', 'networking',
        'https://events.example/e2e-f6-relink',
        TRUE, FALSE, NULL, '{}'::jsonb
      )
      ON CONFLICT (tenant_id, source, external_id) DO UPDATE
        SET name = EXCLUDED.name,
            description = EXCLUDED.description,
            start_date = EXCLUDED.start_date,
            end_date = EXCLUDED.end_date,
            location = EXCLUDED.location,
            category = EXCLUDED.category,
            eventcreate_url = EXCLUDED.eventcreate_url,
            is_partner_benefit = EXCLUDED.is_partner_benefit,
            is_cultural_event = EXCLUDED.is_cultural_event,
            archived_at = EXCLUDED.archived_at,
            last_updated_at = NOW()
      RETURNING event_id::text AS event_id
    `;
    const eventId = eventRows[0]?.event_id;
    if (!eventId) {
      throw new Error('[e2e seed F6 relink] events upsert returned no rows');
    }

    // 3. Resolve the E2E member (used as the counted member in AS2's
    //    fixture row AND as the relink target in AS1). Falls back to
    //    skipping the matched fixture row when the env is missing —
    //    the spec gates with `test.skip` in that path.
    const memberEmail = process.env.E2E_MEMBER_EMAIL;
    let e2eMemberId: string | null = null;
    let e2eContactId: string | null = null;
    let e2eMemberCompany: string | null = null;
    if (memberEmail) {
      const memberRows = await client.sql<
        Array<{
          member_id: string;
          contact_id: string | null;
          company_name: string;
        }>
      >`
        SELECT m.member_id::text AS member_id,
               pc.contact_id::text AS contact_id,
               m.company_name AS company_name
        FROM users u
        JOIN contacts c
          ON c.linked_user_id = u.id AND c.tenant_id = ${tenantSlug}
        JOIN members m
          ON m.member_id = c.member_id AND m.tenant_id = ${tenantSlug}
        LEFT JOIN contacts pc
          ON pc.member_id = m.member_id
         AND pc.tenant_id = ${tenantSlug}
         AND pc.is_primary = TRUE
         AND pc.removed_at IS NULL
        WHERE u.email = ${memberEmail}
        LIMIT 1
      `;
      if (memberRows[0]) {
        e2eMemberId = memberRows[0].member_id;
        e2eContactId = memberRows[0].contact_id;
        e2eMemberCompany = memberRows[0].company_name;
      }
    }

    // 4a. Non-member row — AS1 target.
    const nonMemberRows = await client.sql<Array<{ registration_id: string }>>`
      INSERT INTO event_registrations (
        tenant_id, event_id, external_id,
        attendee_email, attendee_name, attendee_company,
        match_type, matched_member_id, matched_contact_id,
        ticket_type, ticket_price_thb, payment_status,
        counted_against_partnership, counted_against_cultural_quota,
        metadata, registered_at
      ) VALUES (
        ${tenantSlug}, ${eventId}, ${EXT_REG_RELINK_NONMEMBER},
        'relink-target@e2e-f6-relink.example', 'Relink Target Non-member',
        'Relink Co.',
        'non_member', NULL, NULL,
        'Standard ticket', 50000, 'paid',
        FALSE, FALSE, '{}'::jsonb, '2026-06-15T10:00:00Z'
      )
      ON CONFLICT (tenant_id, event_id, external_id) DO UPDATE
        SET attendee_email = EXCLUDED.attendee_email,
            attendee_name = EXCLUDED.attendee_name,
            attendee_company = EXCLUDED.attendee_company,
            match_type = 'non_member',
            matched_member_id = NULL,
            matched_contact_id = NULL,
            payment_status = EXCLUDED.payment_status,
            counted_against_partnership = FALSE,
            counted_against_cultural_quota = FALSE,
            pii_pseudonymised_at = NULL
      RETURNING registration_id::text AS registration_id
    `;
    const nonMemberRegistrationId = nonMemberRows[0]?.registration_id;
    if (!nonMemberRegistrationId) {
      throw new Error(
        '[e2e seed F6 relink] non_member registration upsert returned no rows',
      );
    }

    // 4b. Matched + counted member-contact row — AS2 target. Requires
    //     both a member_id AND contact_id to satisfy the CHECK constraint
    //     `event_registrations_member_contact_requires_ids`. Falls back
    //     to a non_member-shaped row when no e2e-member is resolvable so
    //     the upsert still succeeds (AS2 will then skip gracefully).
    const useMatched = e2eMemberId !== null && e2eContactId !== null;
    const countedRows = await client.sql<Array<{ registration_id: string }>>`
      INSERT INTO event_registrations (
        tenant_id, event_id, external_id,
        attendee_email, attendee_name, attendee_company,
        match_type, matched_member_id, matched_contact_id,
        ticket_type, ticket_price_thb, payment_status,
        counted_against_partnership, counted_against_cultural_quota,
        metadata, registered_at
      ) VALUES (
        ${tenantSlug}, ${eventId}, ${EXT_REG_RELINK_COUNTED},
        ${memberEmail ?? 'counted-fallback@e2e-f6-relink.example'},
        'E2E Counted Member',
        ${e2eMemberCompany ?? 'E2E Member Co.'},
        ${useMatched ? 'member_contact' : 'non_member'},
        ${useMatched ? e2eMemberId : null}::uuid,
        ${useMatched ? e2eContactId : null}::uuid,
        'Member ticket', 0, 'free',
        ${useMatched}, FALSE,
        '{}'::jsonb, '2026-06-15T09:00:00Z'
      )
      ON CONFLICT (tenant_id, event_id, external_id) DO UPDATE
        SET attendee_email = EXCLUDED.attendee_email,
            attendee_name = EXCLUDED.attendee_name,
            attendee_company = EXCLUDED.attendee_company,
            match_type = EXCLUDED.match_type,
            matched_member_id = EXCLUDED.matched_member_id,
            matched_contact_id = EXCLUDED.matched_contact_id,
            payment_status = EXCLUDED.payment_status,
            counted_against_partnership = EXCLUDED.counted_against_partnership,
            counted_against_cultural_quota = EXCLUDED.counted_against_cultural_quota,
            pii_pseudonymised_at = NULL
      RETURNING registration_id::text AS registration_id
    `;
    const countedRegistrationId = countedRows[0]?.registration_id;
    if (!countedRegistrationId) {
      throw new Error(
        '[e2e seed F6 relink] counted registration upsert returned no rows',
      );
    }

    // 4c. Pseudonymised row — FR-014 disallowed-message branch. The row
    //     LOOKS like a non_member but has `pii_pseudonymised_at` set so
    //     the relink dialog renders the disallowed text instead of the
    //     CTA. Email + name + company carry hash-shaped placeholders so
    //     no real PII leaks even if the fixture is inspected.
    const pseudoRows = await client.sql<Array<{ registration_id: string }>>`
      INSERT INTO event_registrations (
        tenant_id, event_id, external_id,
        attendee_email, attendee_name, attendee_company,
        match_type, matched_member_id, matched_contact_id,
        ticket_type, ticket_price_thb, payment_status,
        counted_against_partnership, counted_against_cultural_quota,
        metadata, registered_at, pii_pseudonymised_at
      ) VALUES (
        ${tenantSlug}, ${eventId}, ${EXT_REG_RELINK_PSEUDONYMISED},
        'pseudo-aaaaaaaaaaaaaaaa@e2e-f6-relink.example',
        'pseudo-bbbbbbbbbbbbbbbb',
        'pseudo-cccccccccccccccc',
        'non_member', NULL, NULL,
        'Standard ticket', 30000, 'paid',
        FALSE, FALSE, '{}'::jsonb,
        '2024-04-01T10:00:00Z', NOW()
      )
      ON CONFLICT (tenant_id, event_id, external_id) DO UPDATE
        SET attendee_email = EXCLUDED.attendee_email,
            attendee_name = EXCLUDED.attendee_name,
            attendee_company = EXCLUDED.attendee_company,
            match_type = 'non_member',
            matched_member_id = NULL,
            matched_contact_id = NULL,
            payment_status = EXCLUDED.payment_status,
            pii_pseudonymised_at = NOW()
      RETURNING registration_id::text AS registration_id
    `;
    const pseudonymisedRegistrationId = pseudoRows[0]?.registration_id;
    if (!pseudonymisedRegistrationId) {
      throw new Error(
        '[e2e seed F6 relink] pseudonymised registration upsert returned no rows',
      );
    }

    // 5. Round-1 test-M6 — distinct relink-target member so AS2 can
    //    exercise A→B (not A→A noop). Deterministic UUID + searchable
    //    company name. UPSERT keyed on the company so the seed is
    //    idempotent across re-runs. Fall back to plan_id lookup from
    //    the e2e member (if resolved) OR the chamber's default plan
    //    so the member row satisfies the `members.plan_id` FK.
    const RELINK_TARGET_COMPANY = 'Relink Target E2E Co';
    const RELINK_TARGET_EMAIL = 'relink-target-e2e@chamber.example';
    // Pick an ACTIVE plan for plan_year 2026. The members INSERT below
    // hardcodes plan_year=2026 and members carries a composite FK
    // (tenant_id, plan_id, plan_year) → membership_plans, so the lookup
    // MUST be year-scoped — otherwise a tenant whose active plan belongs
    // to a different year yields a plan_id with no (…, 2026) row and the
    // INSERT fails the FK. ORDER BY plan_id for a deterministic pick.
    const planLookupRows = await client.sql<Array<{ plan_id: string }>>`
      SELECT plan_id
      FROM membership_plans
      WHERE tenant_id = ${tenantSlug} AND plan_year = 2026 AND is_active = TRUE
      ORDER BY plan_id
      LIMIT 1
    `;
    // members.plan_id is NOT NULL with a composite FK — there is no valid
    // "plan-less" member to fall back to, so fail loudly with an
    // actionable message rather than a cryptic NOT NULL / FK violation.
    const relinkPlanId = planLookupRows[0]?.plan_id ?? null;
    if (relinkPlanId === null) {
      throw new Error(
        `[e2e seed F6 relink] no active 2026 membership plan for tenant ` +
          `${tenantSlug} — seed a plan before running the relink fixture`,
      );
    }
    // `members` has no unique constraint on (tenant_id, company_name) —
    // company names are not unique — so ON CONFLICT cannot target it.
    // Reuse the existing test target on re-run (idempotent without deleting
    // its dependent contact/registration rows); otherwise insert a fresh row.
    // ORDER BY makes the pick deterministic if a prior crashed/concurrent
    // run left duplicate-named rows (company_name has no unique constraint).
    const existingRelinkTarget = await client.sql<Array<{ member_id: string }>>`
      SELECT member_id::text AS member_id
      FROM members
      WHERE tenant_id = ${tenantSlug} AND company_name = ${RELINK_TARGET_COMPANY}
      ORDER BY created_at, member_id
      LIMIT 1
    `;
    let relinkTargetMemberId = existingRelinkTarget[0]?.member_id ?? null;
    if (relinkTargetMemberId === null) {
      const insertedRelinkTarget = await client.sql<
        Array<{ member_id: string }>
      >`
        INSERT INTO members (
          member_id, tenant_id, company_name, country, plan_id, plan_year, status
        ) VALUES (
          gen_random_uuid(), ${tenantSlug}, ${RELINK_TARGET_COMPANY}, 'TH',
          ${relinkPlanId}, 2026, 'active'
        )
        RETURNING member_id::text AS member_id
      `;
      relinkTargetMemberId = insertedRelinkTarget[0]?.member_id ?? null;
    } else {
      // Converge the reused row to the canonical fixture state. Clearing
      // archived_at alongside status='active' is required by the
      // members_archived_consistency CHECK (status<>'archived' ⇒
      // archived_at IS NULL); refreshing plan_id/plan_year/country keeps
      // the reuse path identical to a fresh insert.
      await client.sql`
        UPDATE members
          SET status = 'active',
              archived_at = NULL,
              plan_id = ${relinkPlanId},
              plan_year = 2026,
              country = 'TH'
          WHERE tenant_id = ${tenantSlug}
            AND member_id = ${relinkTargetMemberId}::uuid
      `;
    }
    if (!relinkTargetMemberId) {
      throw new Error(
        '[e2e seed F6 relink] relinkTarget member upsert returned no rows',
      );
    }
    // A reused member may already own a DIFFERENT active primary contact;
    // the upsert below forces is_primary=TRUE, which would otherwise
    // collide with the contacts_one_primary_per_member partial unique
    // (tenant_id, member_id) WHERE is_primary AND removed_at IS NULL.
    // Demote any existing active primary first so exactly one remains.
    await client.sql`
      UPDATE contacts
        SET is_primary = FALSE
        WHERE tenant_id = ${tenantSlug}
          AND member_id = ${relinkTargetMemberId}::uuid
          AND is_primary = TRUE
          AND removed_at IS NULL
    `;
    // Primary contact for the target member — required so the picker
    // surfaces a "Relink Target E2E Co · primary contact" hit when
    // the AS2 spec searches by company-name substring.
    await client.sql`
      INSERT INTO contacts (
        contact_id, tenant_id, member_id, first_name, last_name, email, is_primary
      ) VALUES (
        gen_random_uuid(), ${tenantSlug}, ${relinkTargetMemberId}::uuid,
        'Relink', 'Target', ${RELINK_TARGET_EMAIL}, TRUE
      )
      ON CONFLICT (tenant_id, lower(email)) WHERE removed_at IS NULL DO UPDATE
        SET first_name = EXCLUDED.first_name,
            last_name = EXCLUDED.last_name,
            is_primary = TRUE
    `;

    console.log(
      `[e2e seed F6 relink] OK — tenant=${tenantSlug} event=${eventId} ` +
        `registrations=3 (non_member + counted + pseudonymised) ` +
        `e2eMember=${e2eMemberId ?? 'unresolved'} ` +
        `relinkTarget=${relinkTargetMemberId} (${RELINK_TARGET_COMPANY})`,
    );

    return {
      tenantId: tenantSlug,
      eventId,
      nonMemberRegistrationId,
      countedRegistrationId,
      pseudonymisedRegistrationId,
      e2eMemberId,
      e2eMemberCompany,
      relinkTargetMemberId,
      relinkTargetCompany: RELINK_TARGET_COMPANY,
    };
  } finally {
    await client.end();
  }
}
