/**
 * `findEventInvoiceIdByRegistration` cross-tenant isolation integration test
 * (Constitution v1.4.0 Principle I — REVIEW-GATE BLOCKER).
 *
 * The duplicate-CTA path added by 088 takes a RAW event-registration id from a
 * client request and returns an INVOICE id. That shape is exactly the kind
 * that leaks across tenants if scoping slips: the caller never proves it owns
 * the registration, so the only things standing between tenant B and tenant
 * A's invoice id are (a) `withTenantConn` → `runInTenant` →
 * `SET LOCAL app.current_tenant` + RLS, and (b) the explicit
 * `eq(invoices.tenantId, …)` filter. Reading the code says both are present;
 * this test proves it against live Postgres, which is the only place RLS
 * actually runs.
 *
 * Properties proven:
 *   1. In-tenant happy path — A resolves its own event invoice id.
 *   2. Cross-tenant isolation — B querying A's registration id gets `null`,
 *      NOT A's invoice id. THIS is the Principle-I blocker assertion.
 *   3. Genuine miss — an unknown registration id → `null`.
 *
 * The fourth property — a VOIDED invoice is never returned as the duplicate
 * target — is asserted in `void-invoice.test.ts` instead. Voiding requires a
 * genuinely issued row (the `invoices_non_draft_has_snapshots` CHECK demands
 * numbering, snapshots and PDF metadata), so that suite's fixture is the only
 * place a real void exists; faking the row state here would assert against a
 * shape production cannot produce.
 *
 * Lives in tests/integration/** → hits live Neon Singapore via .env.local.
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
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { createEventInvoiceDraft } from '@/modules/invoicing/application/use-cases/create-event-invoice-draft';
import { makeCreateEventInvoiceDraftDeps } from '@/modules/invoicing/application/invoicing-deps';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

const NON_MEMBER_BUYER = {
  legal_name: 'Beta Imports Ltd',
  tax_id: '9876543210123',
  address: '50 Sukhumvit Road, Bangkok 10110',
  primary_contact_name: 'Jane Doe',
  primary_contact_email: 'jane@beta.example',
};

/** Seed one event + one non-member registration inside `tenant`. */
async function seedRegistration(
  tenant: TestTenant,
  label: string,
): Promise<{ eventId: string; registrationId: string }> {
  const eventId = randomUUID();
  const registrationId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(events).values({
      tenantId: tenant.ctx.slug,
      eventId,
      source: 'eventcreate',
      externalId: `evt_dupcta_${label}`,
      name: `Annual Gala (${label})`,
      startDate: new Date('2026-09-10T11:00:00Z'),
    } satisfies NewEventRow);
    await tx.insert(eventRegistrations).values({
      tenantId: tenant.ctx.slug,
      registrationId,
      eventId,
      externalId: `att_dupcta_${label}`,
      attendeeEmail: `guest.${label}@beta.example`,
      attendeeName: 'Beta Guest',
      attendeeCompany: 'Beta Imports Ltd',
      matchType: 'non_member',
      ticketType: 'VIP',
      ticketPriceThb: 3500,
      paymentStatus: 'paid',
      registeredAt: new Date('2026-09-01T03:00:00Z'),
    } satisfies NewEventRegistrationRow);
  });
  return { eventId, registrationId };
}

describe('findEventInvoiceIdByRegistration — cross-tenant isolation (Principle I — REVIEW-GATE BLOCKER)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  let aRegId: string;
  let aInvoiceId: string;

  beforeAll(async () => {
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;
    user = await createActiveTestUser('admin');

    const seeded = await seedRegistration(tenantA, 'a');
    aRegId = seeded.registrationId;

    // Create the event draft through the REAL use-case + composition root, so
    // the row under test is the one production would write.
    const result = await createEventInvoiceDraft(makeCreateEventInvoiceDraftDeps(tenantA.ctx.slug), {
      tenantId: tenantA.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-dupcta-${aRegId}`,
      eventRegistrationId: aRegId,
      buyer: NON_MEMBER_BUYER,
    });
    if (!result.ok) throw new Error(`seed draft failed: ${result.error.code}`);
    aInvoiceId = result.value.invoiceId;
  }, 60_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  });

  it('in-tenant happy path: A resolves its own event invoice id', async () => {
    const found = await makeDrizzleInvoiceRepo(tenantA.ctx.slug).findEventInvoiceIdByRegistration(
      aRegId,
      tenantA.ctx.slug,
    );

    expect(found).toBe(aInvoiceId);
  });

  it('cross-tenant isolation: B querying A registration id gets null, NOT A invoice id (Principle-I blocker)', async () => {
    const found = await makeDrizzleInvoiceRepo(tenantB.ctx.slug).findEventInvoiceIdByRegistration(
      aRegId,
      tenantB.ctx.slug,
    );

    expect(found).toBeNull();
    // Stated separately so a regression that leaks the id fails with a message
    // naming what leaked, not just "expected null".
    expect(found).not.toBe(aInvoiceId);
  });

  it('genuine miss: A queries an unknown registration id → null', async () => {
    const found = await makeDrizzleInvoiceRepo(tenantA.ctx.slug).findEventInvoiceIdByRegistration(
      randomUUID(),
      tenantA.ctx.slug,
    );

    expect(found).toBeNull();
  });
});
