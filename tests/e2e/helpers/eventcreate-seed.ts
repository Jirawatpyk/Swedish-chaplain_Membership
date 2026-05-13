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
    // Order matters: registrations FK → events; receipts independent.
    // Webhook config last because verifier reads it on next webhook hit.
    await client.sql`DELETE FROM event_registrations WHERE tenant_id = ${tenantSlug}`;
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
