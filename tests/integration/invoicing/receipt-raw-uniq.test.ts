/**
 * 064 Task 10 (review Finding 2) — migration 0213 receipt-number uniqueness
 * backstop (live Neon Singapore via .env.local).
 *
 * `receipt_document_number_raw` carries §87 RECEIPT-stream numbers from two
 * writers (recordPayment separate-mode + issueEventInvoiceAsPaid no-TIN β).
 * The invoice stream has `invoices_tenant_fiscal_seq_unique` as its duplicate
 * backstop; migration 0213 adds the receipt-stream equivalent:
 *
 *   CREATE UNIQUE INDEX invoices_tenant_receipt_raw_uniq
 *     ON invoices (tenant_id, receipt_document_number_raw)
 *     WHERE receipt_document_number_raw IS NOT NULL;
 *
 * Probes:
 *   1. second row with the SAME (tenant, raw) → SQLSTATE 23505 naming the
 *      0213 index (a duplicate receipt number can never be persisted);
 *   2. the SAME raw in a DIFFERENT tenant → commits fine (numbering is
 *      per-tenant — the index must not leak across tenants).
 *
 * The probe rows are minimal event DRAFTS (the partial index keys only on
 * raw IS NOT NULL, not on status) — the lightest legal shape that exercises
 * the index. All identities SIMULATED.
 *
 * Lives in tests/integration/** → hits live Neon. Migration 0213 MUST be
 * applied first (`pnpm db:migrate`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import {
  events,
  eventRegistrations,
  type NewEventRow,
  type NewEventRegistrationRow,
} from '@/modules/events/infrastructure/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import {
  createTwoTestTenants,
  type TestTenant,
} from '../helpers/test-tenant';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';

const DUP_RAW = 'RC-2026-000777';

/** Seed one simulated event + one registration in a tenant; returns ids. */
async function seedEventWithRegistration(
  tenant: TestTenant,
): Promise<{ eventId: string; registrationId: string }> {
  const eventId = randomUUID();
  const registrationId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(events).values({
      tenantId: tenant.ctx.slug,
      eventId,
      source: 'eventcreate',
      externalId: `evt-rru-${registrationId.slice(0, 8)}`,
      name: 'Receipt Raw Uniq Gala',
      startDate: new Date('2026-09-10T11:00:00Z'),
    } satisfies NewEventRow);
    await tx.insert(eventRegistrations).values({
      tenantId: tenant.ctx.slug,
      registrationId,
      eventId,
      externalId: `att-rru-${registrationId.slice(0, 8)}`,
      attendeeEmail: 'sim.rru@receipt-uniq.test',
      attendeeName: 'Sim Attendee',
      attendeeCompany: null,
      matchType: 'non_member',
      ticketType: 'Standard',
      ticketPriceThb: 100,
      paymentStatus: 'paid',
      registeredAt: new Date('2026-09-01T03:00:00Z'),
    } satisfies NewEventRegistrationRow);
  });
  return { eventId, registrationId };
}

/** Minimal legal event DRAFT row carrying a receipt raw (probe shape). */
async function insertDraftWithRaw(
  tenant: TestTenant,
  userId: string,
  eventId: string,
  registrationId: string,
  raw: string,
): Promise<string> {
  const invoiceId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(invoices).values({
      tenantId: tenant.ctx.slug,
      invoiceId,
      invoiceSubject: 'event',
      eventId,
      eventRegistrationId: registrationId,
      vatInclusive: true,
      memberId: null,
      planId: null,
      planYear: null,
      draftByUserId: userId,
      status: 'draft',
      receiptDocumentNumberRaw: raw,
    });
  });
  return invoiceId;
}

describe('invoices_tenant_receipt_raw_uniq — 0213 receipt-number backstop (live Neon)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  let eventA: { eventId: string; registrationId: string };
  let eventA2: { eventId: string; registrationId: string };
  let eventB: { eventId: string; registrationId: string };

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    ({ a: tenantA, b: tenantB } = await createTwoTestTenants());
    eventA = await seedEventWithRegistration(tenantA);
    eventA2 = await seedEventWithRegistration(tenantA);
    eventB = await seedEventWithRegistration(tenantB);
    // First raw-bearing row in tenant A — the duplicate target.
    await insertDraftWithRaw(
      tenantA,
      user.userId,
      eventA.eventId,
      eventA.registrationId,
      DUP_RAW,
    );
  }, 90_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
    await deleteTestUser(user).catch(() => {});
  });

  it('second row with the SAME (tenant, receipt raw) → 23505 on invoices_tenant_receipt_raw_uniq', async () => {
    let caught: unknown = null;
    try {
      await insertDraftWithRaw(
        tenantA,
        user.userId,
        eventA2.eventId,
        eventA2.registrationId,
        DUP_RAW,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught, 'expected a unique_violation (23505)').not.toBeNull();
    // Drizzle 0.45+ wraps the PostgresError — walk the cause chain (same
    // pattern as issue-as-paid.test.ts expectNumberingCheckViolation).
    let code: string | null = null;
    let constraint: string | null = null;
    const messages: string[] = [];
    let cur: unknown = caught;
    while (cur !== null && typeof cur === 'object') {
      const c = cur as {
        code?: unknown;
        constraint_name?: unknown;
        message?: unknown;
        cause?: unknown;
      };
      if (code === null && typeof c.code === 'string') code = c.code;
      if (constraint === null && typeof c.constraint_name === 'string') {
        constraint = c.constraint_name;
      }
      if (typeof c.message === 'string') messages.push(c.message);
      cur = c.cause ?? null;
    }
    expect(code).toBe('23505');
    expect(`${constraint ?? ''} ${messages.join(' | ')}`).toMatch(
      /invoices_tenant_receipt_raw_uniq/,
    );
  }, 30_000);

  it('the SAME receipt raw in a DIFFERENT tenant commits fine (per-tenant numbering scope)', async () => {
    // Must NOT throw — tenant B legitimately runs its own receipt stream.
    const invoiceId = await insertDraftWithRaw(
      tenantB,
      user.userId,
      eventB.eventId,
      eventB.registrationId,
      DUP_RAW,
    );
    expect(invoiceId).toBeTruthy();
  }, 30_000);
});
