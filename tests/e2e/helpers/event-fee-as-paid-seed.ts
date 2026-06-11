/**
 * E2E seed for 064-event-invoice-paid-flow (Task 14) — event-fee AS-PAID
 * form-mode fixtures.
 *
 * Seeds ONE dedicated event + five SIMULATED non-member registrations
 * covering every F6 `payment_status` the issuance-mode selector branches on:
 *
 *   • paid (TIN scenario)      — default already_paid; the spec SUBMITS the
 *                                two-step create+issue flow (real invoice).
 *   • paid (no-TIN scenario)   — bill_first disabled probe + future-date
 *                                inline-error probe (never submits OK).
 *   • pending                  — waiting explainer + override + reactive
 *                                TIN default flip (never submits).
 *   • refunded                 — hard-block card (never submits).
 *   • paid (two-step scenario) — the spec intercepts /issue-as-paid with a
 *                                500 so the DRAFT remains (real draft row).
 *
 * Idempotency: the one-non-void-event-invoice-per-registration unique index
 * (`invoices_event_registration_uniq`) would 409 a re-run after the submit
 * scenarios, so the seed DELETEs any invoices referencing the sentinel
 * registrations first (invoice_lines cascade via FK; the immutability
 * trigger is BEFORE UPDATE only, so owner-role DELETE passes). Audit rows
 * are LEFT IN PLACE (Principle I — never delete from audit_log). This is
 * test-fixture hygiene on the local/dev tenant only — the deleted rows are
 * e2e-created fixtures, never operator data.
 *
 * All attendees/buyers are SIMULATED (fake names, fake emails); the fake
 * 13-digit TIN is typed by the spec, not stored here. Connects via
 * `neondb_owner` (bypasses RLS) — same pattern as `eventcreate-seed.ts`.
 *
 * §87 NOTE (T15): each re-run's submit scenarios consume real §87 sequence
 * numbers, and the invoice DELETE above leaves those consumed numbers as
 * gaps in the DEV tenant's invoice stream — acceptable on the dev/E2E
 * tenant only; a production tenant must never run this seed.
 */
import { openSeedClient, type SeedClient } from './open-seed-client';

const TENANT_ID = process.env.E2E_TENANT_SLUG ?? process.env.TENANT_SLUG ?? 'swecham';

/** Warn-label prefix for the shared owner-role client (wave-4 S20). */
const SEED_LABEL = 'e2e seed 064 as-paid';

const EXT_EVENT_AS_PAID = 'e2e-064-event-as-paid';

const EXT_REG_PAID_TIN = 'e2e-064-reg-paid-tin';
const EXT_REG_PAID_NO_TIN = 'e2e-064-reg-paid-no-tin';
const EXT_REG_PENDING = 'e2e-064-reg-pending';
const EXT_REG_REFUNDED = 'e2e-064-reg-refunded';
const EXT_REG_TWO_STEP = 'e2e-064-reg-two-step';

/** Attendee display names — the spec clicks picker rows by these. */
export const AS_PAID_ATTENDEES = {
  paidTin: 'Sim PaidTin Guest',
  paidNoTin: 'Sim PaidNoTin Guest',
  pending: 'Sim Pending Guest',
  refunded: 'Sim Refunded Guest',
  twoStep: 'Sim TwoStep Guest',
} as const;

export interface SeedAsPaidFixtureResult {
  readonly tenantId: string;
  readonly eventId: string;
  readonly registrationIds: {
    readonly paidTin: string;
    readonly paidNoTin: string;
    readonly pending: string;
    readonly refunded: string;
    readonly twoStep: string;
  };
}

export async function seedEventFeeAsPaidFixture(
  tenantSlug: string = TENANT_ID,
): Promise<SeedAsPaidFixtureResult | null> {
  const client = openSeedClient(SEED_LABEL);
  if (!client) return null;
  try {
    // 1. Webhook config — enabled so the F6 admin surfaces treat the
    //    integration as live (same UPSERT as seedF6Events; secret value is
    //    irrelevant here — this spec never signs webhooks).
    await client.sql`
      INSERT INTO tenant_webhook_configs (
        tenant_id, source, webhook_secret_active, enabled, last_received_at
      ) VALUES (
        ${tenantSlug}, 'eventcreate',
        'whsec_F6E2EFixtureSecretForLocalAndCIRuns2026', TRUE, NOW()
      )
      ON CONFLICT (tenant_id, source) DO UPDATE
        SET enabled = TRUE, last_received_at = NOW()
    `;

    // 2. Dedicated event — unflagged (no partner-benefit / cultural quota
    //    side-effects), future-dated so it sorts near the top of the picker.
    const eventRows = await client.sql<Array<{ event_id: string }>>`
      INSERT INTO events (
        tenant_id, source, external_id,
        name, description, start_date, end_date, location, category,
        is_partner_benefit, is_cultural_event, archived_at, metadata
      ) VALUES (
        ${tenantSlug}, 'eventcreate', ${EXT_EVENT_AS_PAID},
        'E2E 064 As-Paid Event',
        'Seeded by tests/e2e/helpers/event-fee-as-paid-seed.ts',
        '2026-08-20T11:00:00Z', '2026-08-20T15:00:00Z',
        'Bangkok', 'networking',
        FALSE, FALSE, NULL, '{}'::jsonb
      )
      ON CONFLICT (tenant_id, source, external_id) DO UPDATE
        SET name = EXCLUDED.name,
            description = EXCLUDED.description,
            start_date = EXCLUDED.start_date,
            end_date = EXCLUDED.end_date,
            archived_at = NULL,
            last_updated_at = NOW()
      RETURNING event_id::text AS event_id
    `;
    const eventId = eventRows[0]?.event_id;
    if (!eventId) {
      throw new Error('[e2e seed 064 as-paid] events upsert returned no rows');
    }

    // 3. Idempotency reset — drop invoices created by PRIOR runs of the
    //    submit scenarios so the partial unique index never 409s a re-run.
    //    invoice_lines cascade via `invoice_lines_invoice_fk ON DELETE
    //    CASCADE`; audit rows stay (append-only, Principle I).
    const sentinels = [
      EXT_REG_PAID_TIN,
      EXT_REG_PAID_NO_TIN,
      EXT_REG_PENDING,
      EXT_REG_REFUNDED,
      EXT_REG_TWO_STEP,
    ];
    await client.sql`
      DELETE FROM invoices
      WHERE tenant_id = ${tenantSlug}
        AND event_registration_id IN (
          SELECT registration_id FROM event_registrations
          WHERE tenant_id = ${tenantSlug}
            AND event_id = ${eventId}
            AND external_id IN ${client.sql(sentinels)}
        )
    `;

    // 4. Five SIMULATED non-member registrations — one per form-mode branch.
    //    CHECK `event_registrations_non_member_no_quota`: non_member rows
    //    need NULL matched ids + FALSE quota flags.
    const regRows = await client.sql<
      Array<{ registration_id: string; external_id: string }>
    >`
      INSERT INTO event_registrations (
        tenant_id, event_id, external_id,
        attendee_email, attendee_name, attendee_company,
        match_type, matched_member_id, matched_contact_id,
        ticket_type, ticket_price_thb, payment_status,
        counted_against_partnership, counted_against_cultural_quota,
        metadata, registered_at
      ) VALUES
        (${tenantSlug}, ${eventId}, ${EXT_REG_PAID_TIN},
         'sim.paidtin@e2e-064.example', ${AS_PAID_ATTENDEES.paidTin}, 'Sim AsPaid Co Ltd',
         'non_member', NULL, NULL,
         'Standard', 1070, 'paid',
         FALSE, FALSE, '{}'::jsonb, '2026-06-01T10:00:00Z'),
        (${tenantSlug}, ${eventId}, ${EXT_REG_PAID_NO_TIN},
         'sim.paidnotin@e2e-064.example', ${AS_PAID_ATTENDEES.paidNoTin}, 'Sim Walkin Co',
         'non_member', NULL, NULL,
         'Standard', 535, 'paid',
         FALSE, FALSE, '{}'::jsonb, '2026-06-01T10:05:00Z'),
        (${tenantSlug}, ${eventId}, ${EXT_REG_PENDING},
         'sim.pending@e2e-064.example', ${AS_PAID_ATTENDEES.pending}, 'Sim Pending Co',
         'non_member', NULL, NULL,
         'Standard', 856, 'pending',
         FALSE, FALSE, '{}'::jsonb, '2026-06-01T10:10:00Z'),
        (${tenantSlug}, ${eventId}, ${EXT_REG_REFUNDED},
         'sim.refunded@e2e-064.example', ${AS_PAID_ATTENDEES.refunded}, 'Sim Refunded Co',
         'non_member', NULL, NULL,
         'Standard', 321, 'refunded',
         FALSE, FALSE, '{}'::jsonb, '2026-06-01T10:15:00Z'),
        (${tenantSlug}, ${eventId}, ${EXT_REG_TWO_STEP},
         'sim.twostep@e2e-064.example', ${AS_PAID_ATTENDEES.twoStep}, 'Sim TwoStep Co',
         'non_member', NULL, NULL,
         'Standard', 1070, 'paid',
         FALSE, FALSE, '{}'::jsonb, '2026-06-01T10:20:00Z')
      ON CONFLICT (tenant_id, event_id, external_id) DO UPDATE
        SET attendee_email = EXCLUDED.attendee_email,
            attendee_name = EXCLUDED.attendee_name,
            attendee_company = EXCLUDED.attendee_company,
            match_type = 'non_member',
            matched_member_id = NULL,
            matched_contact_id = NULL,
            ticket_type = EXCLUDED.ticket_type,
            ticket_price_thb = EXCLUDED.ticket_price_thb,
            payment_status = EXCLUDED.payment_status,
            counted_against_partnership = FALSE,
            counted_against_cultural_quota = FALSE,
            pii_pseudonymised_at = NULL,
            registered_at = EXCLUDED.registered_at
      RETURNING registration_id::text AS registration_id, external_id
    `;
    const byExt = new Map(regRows.map((r) => [r.external_id, r.registration_id]));
    const ids = {
      paidTin: byExt.get(EXT_REG_PAID_TIN),
      paidNoTin: byExt.get(EXT_REG_PAID_NO_TIN),
      pending: byExt.get(EXT_REG_PENDING),
      refunded: byExt.get(EXT_REG_REFUNDED),
      twoStep: byExt.get(EXT_REG_TWO_STEP),
    };
    if (!ids.paidTin || !ids.paidNoTin || !ids.pending || !ids.refunded || !ids.twoStep) {
      throw new Error('[e2e seed 064 as-paid] registrations upsert returned <5 rows');
    }

    console.log(
      `[e2e seed 064 as-paid] OK — tenant=${tenantSlug} event=${eventId} ` +
        `registrations=5 (paid-tin / paid-no-tin / pending / refunded / two-step)`,
    );

    return {
      tenantId: tenantSlug,
      eventId,
      registrationIds: {
        paidTin: ids.paidTin,
        paidNoTin: ids.paidNoTin,
        pending: ids.pending,
        refunded: ids.refunded,
        twoStep: ids.twoStep,
      },
    };
  } finally {
    await client.end();
  }
}

export interface InvoiceRowForRegistration {
  readonly status: string;
  readonly pdfDocKind: string | null;
  readonly documentNumber: string | null;
  readonly paymentDate: string | null;
}

/**
 * Owner-role read of the single non-void event invoice for a registration —
 * lets the spec verify what the two-step flow actually PERSISTED (e.g.
 * `pdf_doc_kind = 'receipt_combined'` after the TIN as-paid submit; status
 * stays `draft` after the intercepted issue failure).
 *
 * Wave-4 S30 — pass `sharedClient` (spec-managed, e.g. opened in
 * `beforeAll` / ended in `afterAll`) to reuse ONE connection across the
 * spec's reads instead of opening + tearing down a fresh Neon client per
 * call; ownership stays with the caller (this function never ends it).
 */
export async function readInvoiceForRegistration(
  registrationId: string,
  tenantSlug: string = TENANT_ID,
  sharedClient?: SeedClient,
): Promise<InvoiceRowForRegistration | null> {
  const client = sharedClient ?? openSeedClient(SEED_LABEL);
  if (!client) {
    throw new Error(
      'readInvoiceForRegistration requires DATABASE_URL — the calling spec ' +
        'is gated on E2E_ADMIN_*; if those are set, DATABASE_URL must be too.',
    );
  }
  try {
    const rows = await client.sql<
      Array<{
        status: string;
        pdf_doc_kind: string | null;
        document_number: string | null;
        payment_date: string | null;
      }>
    >`
      SELECT status, pdf_doc_kind, document_number, payment_date::text AS payment_date
      FROM invoices
      WHERE tenant_id = ${tenantSlug}
        AND event_registration_id = ${registrationId}::uuid
        AND status <> 'void'
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      status: row.status,
      pdfDocKind: row.pdf_doc_kind,
      documentNumber: row.document_number,
      paymentDate: row.payment_date,
    };
  } finally {
    // Only close a connection THIS call opened — a shared client's
    // lifecycle belongs to the spec (S30).
    if (!sharedClient) await client.end();
  }
}
