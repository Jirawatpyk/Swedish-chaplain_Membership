/**
 * 054-event-fee-invoices (Task 4) — `invoices` event-subject schema
 * integration test (live Neon).
 *
 * Pins the migration-0201 generalisation against the database so a future
 * `DROP CONSTRAINT` / `DROP NOT NULL` regression breaks CI rather than
 * silently shipping. Unit mocks cannot exercise these DB-level guarantees
 * (the CHECK, the partial unique index, the composite FK) — they only show
 * up against live Postgres (F4-R8 discipline).
 *
 * Scenarios:
 *   (1) An `invoice_subject='event'` draft with member_id/plan_id/plan_year
 *       NULL + event_id + event_registration_id set persists, and
 *       `rowsToInvoice` maps invoiceSubject/memberId/eventRegistrationId.
 *   (2) The CHECK `invoices_subject_fields_ck` rejects a membership row with
 *       member_id NULL.
 *   (3) The partial unique index rejects a SECOND non-void event invoice for
 *       the same (tenant_id, event_registration_id), but ALLOWS a second once
 *       the first is voided (status='void').
 *
 * The composite FK `invoices_event_registration_fk` is satisfied by seeding a
 * real F6 `event_registrations` row first; cross-tenant FK/RLS isolation is
 * the subject of the dedicated cross-tenant probe test (Task 5).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { events, eventRegistrations } from '@/modules/events/infrastructure/schema';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { asInvoiceId } from '@/modules/invoicing/domain/invoice';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';

const SEED_FAR_FUTURE = new Date('2099-01-01T00:00:00Z');

/** Seed a minimal F6 event + registration so the composite FK is satisfied. */
async function seedRegistration(
  tenant: TestTenant,
): Promise<{ eventId: string; registrationId: string }> {
  const eventId = randomUUID();
  const registrationId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(events).values({
      eventId,
      tenantId: tenant.ctx.slug,
      externalId: `evt-fee-${randomUUID().slice(0, 8)}`,
      source: 'admin_manual',
      name: 'Event-fee invoice test event',
      startDate: SEED_FAR_FUTURE,
      isPartnerBenefit: false,
      isCulturalEvent: false,
    });
    await tx.insert(eventRegistrations).values({
      registrationId,
      tenantId: tenant.ctx.slug,
      eventId,
      externalId: `att-${randomUUID().slice(0, 8)}`,
      attendeeEmail: `attendee-${randomUUID().slice(0, 8)}@evt-fee.test`,
      attendeeName: 'Event Fee Attendee',
      matchType: 'non_member',
      paymentStatus: 'paid',
      registeredAt: new Date(),
    });
  });
  return { eventId, registrationId };
}

/**
 * Assert a callback throws a Postgres error whose SQLSTATE matches the
 * supplied code (Drizzle wraps the PostgresError under `.cause`).
 *   - 23514 = check_violation
 *   - 23505 = unique_violation
 */
async function expectPgError(fn: () => Promise<unknown>, sqlstate: string): Promise<void> {
  let caught: unknown = null;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).not.toBeNull();
  const err = caught as { cause?: { code?: string }; code?: string };
  const code = err.cause?.code ?? err.code ?? null;
  expect(code).toBe(sqlstate);
}

describe('invoices event-subject schema — 054-event-fee-invoices (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(user).catch(() => {});
  });

  it('(1) persists an event-subject draft (null member/plan) + maps via rowsToInvoice', async () => {
    const { eventId, registrationId } = await seedRegistration(tenant);
    const repo = makeDrizzleInvoiceRepo(tenant.ctx.slug);
    const invoiceId = asInvoiceId(randomUUID());

    const invoice = await repo.withTx((tx) =>
      repo.insertDraft(tx, {
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId: null,
        planId: null,
        planYear: null,
        invoiceSubject: 'event',
        eventId,
        eventRegistrationId: registrationId,
        vatInclusive: true,
        draftByUserId: user.userId,
        autoEmailOnIssue: null,
        lines: [],
      }),
    );

    // Domain mapping (rowsToInvoice) round-trip.
    expect(invoice.invoiceSubject).toBe('event');
    expect(invoice.memberId).toBeNull();
    expect(invoice.planId).toBeNull();
    expect(invoice.planYear).toBeNull();
    expect(invoice.eventId).toBe(eventId);
    expect(invoice.eventRegistrationId).toBe(registrationId);
    expect(invoice.vatInclusive).toBe(true);

    // Persisted row matches.
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(invoices).where(eq(invoices.invoiceId, invoiceId)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.invoiceSubject).toBe('event');
    expect(rows[0]!.memberId).toBeNull();
    expect(rows[0]!.eventRegistrationId).toBe(registrationId);
    expect(rows[0]!.vatInclusive).toBe(true);
  }, 60_000);

  it('(2) CHECK rejects a membership row with member_id NULL', async () => {
    await expectPgError(
      () =>
        runInTenant(tenant.ctx, (tx) =>
          tx.insert(invoices).values({
            tenantId: tenant.ctx.slug,
            invoiceId: randomUUID(),
            // invoice_subject defaults to 'membership' → CHECK requires
            // member_id/plan_id/plan_year. Leave them NULL → violation.
            memberId: null,
            planId: null,
            planYear: null,
            draftByUserId: user.userId,
            status: 'draft',
          }),
        ),
      '23514',
    );
  }, 60_000);

  it('(3) partial unique index — one non-void event invoice per registration; void is excluded', async () => {
    const { eventId, registrationId } = await seedRegistration(tenant);

    // Insert a `draft` event invoice. Drafts ARE indexed by the partial
    // index (predicate `status <> 'void'`) and bypass the lifecycle
    // snapshot/number CHECKs, so this is the lean way to exercise the
    // uniqueness rule without reconstructing a full issued/void row (which
    // would need sequence_number + snapshots + pdf — out of scope here).
    async function insertDraftEventInvoice(): Promise<string> {
      const invoiceId = randomUUID();
      await runInTenant(tenant.ctx, (tx) =>
        tx.insert(invoices).values({
          tenantId: tenant.ctx.slug,
          invoiceId,
          memberId: null,
          planId: null,
          planYear: null,
          invoiceSubject: 'event',
          eventId,
          eventRegistrationId: registrationId,
          status: 'draft',
          draftByUserId: user.userId,
        }),
      );
      return invoiceId;
    }

    // First non-void (draft) event invoice — OK.
    const firstId = await insertDraftEventInvoice();

    // Second non-void event invoice for the SAME registration — rejected by
    // the partial unique index (23505).
    await expectPgError(() => insertDraftEventInvoice(), '23505');

    // The index DDL's partial predicate MUST exclude voided invoices — this
    // is the "a voided event invoice frees the registration for re-issue"
    // contract. Assert the predicate is literally `status <> 'void'` (and
    // scoped to event rows) so a regression that drops/weakens the WHERE
    // clause — e.g. mistakenly to `status <> 'voided'`, a non-existent enum
    // value that would make the predicate always-true and silently widen
    // the index to cover voided rows — breaks CI.
    const idxDef = await runInTenant(tenant.ctx, (tx) =>
      tx.execute(
        sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'invoices_event_registration_uniq'`,
      ),
    );
    const indexdef = (idxDef as unknown as Array<{ indexdef: string }>)[0]?.indexdef ?? '';
    expect(indexdef).toContain(`(invoice_subject = 'event'::invoice_subject)`);
    expect(indexdef).toContain(`status <> 'void'::invoice_status`);
    // Negative guard: the broken `'voided'` literal must NOT appear.
    expect(indexdef).not.toContain(`'voided'`);

    // Free the slot by deleting the conflicting draft, then a fresh non-void
    // event invoice for the same registration is allowed again.
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .delete(invoices)
        .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, firstId))),
    );
    const secondId = await insertDraftEventInvoice();
    expect(secondId).not.toBe(firstId);

    // Sanity: exactly one non-void event invoice for this registration.
    const live = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(invoices)
        .where(
          and(
            eq(invoices.tenantId, tenant.ctx.slug),
            eq(invoices.eventRegistrationId, registrationId),
            sql`status <> 'void'`,
          ),
        ),
    );
    expect(live[0]!.n).toBe(1);
  }, 90_000);
});
