/**
 * 107-auto-invoice Task 11 — `pruneAutoDrafts` + `reconcileIssuedOrphans`
 * integration test (live Neon). These are the recovery/cleanup rails for
 * the auto-draft feature (Tasks 6/7/9):
 *
 *   - `pruneAutoDrafts` discards `origin='auto_renewal' status='draft'`
 *     invoices whose cycle has LEFT `upcoming|reminded` (member
 *     self-renewed, or the cycle lapsed after a T-30 draft).
 *   - `reconcileIssuedOrphans` finds `origin='auto_renewal' status='issued'`
 *     invoices whose member's cycle has `linked_invoice_id IS NULL` and
 *     re-links them — the backstop for a burned §87 number whose
 *     `issueAutoDraftedRenewal` tx2 link step failed
 *     (`F8.AUTO_ISSUE.LINK_FAILED`).
 *
 * Scenario map:
 *   (a1) prune — cycle self-renewed (flipped to awaiting_payment) →
 *        stale draft discarded, `renewal_auto_draft_discarded
 *        {reason:'pruned_left_window'}` audit row written.
 *   (a2) prune — idempotent: re-running finds 0 candidates (the join
 *        naturally excludes a deleted invoice).
 *   (a3) prune — throw-path: one candidate's discard call throws →
 *        the OTHER candidate is still pruned; `errors` counts the throw.
 *   (a4) prune — a candidate that vanished between the list-scan and
 *        processing (simulated via a deps override returning a
 *        fabricated non-existent invoice id) is skipped WITHOUT emitting
 *        `invoice_cross_tenant_probe` (expectMayHaveVanished threading).
 *   (a5) prune — a candidate concurrently promoted to `issued` (F4 returns
 *        `not_draft`) is left untouched, not miscounted as an error.
 *   (b1) reconcile — an issued auto-drafted invoice whose cycle never got
 *        linked (tx2 never ran) gets re-linked: cycle flips to
 *        `awaiting_payment` + `linked_invoice_id` set.
 *   (b2) reconcile — idempotent: re-running finds 0 candidates.
 *   (b3) reconcile — a correctly-linked sibling pair is never touched.
 *   (b4) reconcile — a cycle that reached a TERMINAL status (lapsed)
 *        before the link could be repaired is left alone
 *        (`skippedTerminal`), never force-linked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { deriveFiscalYear } from '@/lib/fiscal-year';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { makeRenewalsDeps, CycleTransitionConflictError } from '@/modules/renewals';
import { pruneAutoDrafts } from '@/modules/renewals/application/use-cases/prune-auto-drafts';
import { reconcileIssuedOrphans } from '@/modules/renewals/application/use-cases/reconcile-issued-orphans';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import { createInMemoryBlobStorage } from '../../helpers/in-memory-blob-storage';
/**
 * This suite drives the real F4 issue path, which uploads a rendered PDF.
 * Injected rather than left to the production adapter: CI's
 * `BLOB_READ_WRITE_TOKEN` is an `.env.example` placeholder pointing at no
 * store, which is what reddened the first nightly renewals sweep — and a local
 * run was writing test PDFs into the dev store.
 */
const testBlob = createInMemoryBlobStorage();


const NOW = new Date('2026-07-20T00:00:00.000Z');
/** Every fixture cycle starts here → `deriveFiscalYear(periodFrom)` = 2025. */
const PERIOD_FROM = '2025-08-01T00:00:00Z';
const PLAN_YEAR = deriveFiscalYear(PERIOD_FROM);

// THREE separate tenants. `pruneAutoDrafts`'s throw-path/vanished-target
// scenarios deliberately leave behind `status='draft'`/`status='issued',
// linked_invoice_id=NULL` rows that would otherwise be picked up as
// genuine (unrelated) candidates by the OTHER use-case's query if both
// suites shared one tenant — the two crons' candidate predicates are
// close enough (both key off `origin='auto_renewal'`) that cross-suite
// pollution silently breaks absolute `candidatesFound` assertions.
// `tenant3` isolates (b5)/(b6) from (b4): a terminal-skipped orphan is a
// PERMANENT, by-design leftover in `listIssuedAutoInvoiceOrphans` (it can
// never self-heal — the cycle is closed), so any test running after (b4)
// in a shared tenant would see it as an extra, unrelated candidate.
// Isolating by tenant removes the dependency on run order / cleanup
// discipline entirely.
let tenant: TestTenant;
let tenant2: TestTenant;
let tenant3: TestTenant;
let user: TestUser;
let planId: string;
let planId2: string;
let planId3: string;

function depsFor(t: TestTenant) {
  const real = makeRenewalsDeps(t.ctx.slug, { blob: testBlob });
  return { ...real, clock: { now: () => NOW } };
}

async function seedMember(t: TestTenant, memberPlanId: string): Promise<string> {
  const memberId = randomUUID();
  await runInTenant(t.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: t.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `Task11 Co ${memberId.slice(0, 6)}`,
      country: 'TH' as const,
      taxId: '9999999999999',
      addressLine1: '99 Rama IV Road',
      city: 'Sathon',
      province: 'Bangkok',
      postalCode: '10120',
      planId: memberPlanId,
      planYear: PLAN_YEAR,
      billingCycle: 'rolling',
      autoInvoiceEnrolledAt: new Date('2026-01-01T00:00:00Z'),
    });
    await tx.insert(contacts).values({
      tenantId: t.ctx.slug,
      contactId: randomUUID(),
      memberId,
      firstName: 'Task11',
      lastName: 'Test',
      email: `task11.${memberId.slice(0, 8)}@member.example`,
      isPrimary: true,
    });
  });
  return memberId;
}

async function seedCycle(
  t: TestTenant,
  memberId: string,
  cyclePlanId: string,
): Promise<string> {
  const cycleId = randomUUID();
  const periodFrom = new Date(PERIOD_FROM);
  const periodTo = new Date(periodFrom);
  periodTo.setUTCMonth(periodTo.getUTCMonth() + 12);
  await runInTenant(t.ctx, (tx) =>
    tx.insert(renewalCycles).values({
      tenantId: t.ctx.slug,
      cycleId,
      memberId,
      status: 'upcoming',
      periodFrom,
      periodTo,
      expiresAt: periodTo,
      cycleLengthMonths: 12,
      tierAtCycleStart: 'regular',
      planIdAtCycleStart: cyclePlanId,
      frozenPlanPriceThb: '50000.00',
      frozenPlanTermMonths: 12,
      frozenPlanCurrency: 'THB',
      anchoredAt: periodFrom,
    }),
  );
  return cycleId;
}

/** Creates a genuine `origin='auto_renewal'` draft via the T5 bridge (the
 *  exact call Task 7's cron makes) and stamps it onto the cycle. */
async function seedAutoDraft(
  t: TestTenant,
  memberId: string,
  cycleId: string,
  draftPlanId: string,
): Promise<string> {
  const deps = depsFor(t);
  const drafted = await deps.f4InvoicingBridge.draftInvoiceForRenewal({
    tenantId: t.ctx.slug,
    memberId,
    planId: draftPlanId,
    planYear: PLAN_YEAR,
    frozenPlanPriceThb: '50000.00' as never,
    coverageWindow: { fromIso: '2026-01-01T00:00:00.000Z', toIso: '2027-01-01T00:00:00.000Z' },
    actorUserId: user.userId,
    requestId: null,
  });
  if (drafted.status !== 'drafted') {
    throw new Error(`fixture draft failed: ${JSON.stringify(drafted)}`);
  }
  await runInTenant(t.ctx, (tx) =>
    tx
      .update(renewalCycles)
      .set({ autoDraftInvoiceId: drafted.invoiceId })
      .where(eq(renewalCycles.cycleId, cycleId)),
  );
  return drafted.invoiceId;
}

/** member + cycle(upcoming) + stamped auto-draft — the standard fixture. */
async function seedQueueRow(
  t: TestTenant,
  rowPlanId: string,
): Promise<{
  readonly memberId: string;
  readonly cycleId: string;
  readonly invoiceId: string;
}> {
  const memberId = await seedMember(t, rowPlanId);
  const cycleId = await seedCycle(t, memberId, rowPlanId);
  const invoiceId = await seedAutoDraft(t, memberId, cycleId, rowPlanId);
  return { memberId, cycleId, invoiceId };
}

async function invoiceExists(t: TestTenant, invoiceId: string): Promise<boolean> {
  const rows = await runInTenant(t.ctx, (tx) =>
    tx
      .select({ invoiceId: invoices.invoiceId })
      .from(invoices)
      .where(and(eq(invoices.tenantId, t.ctx.slug), eq(invoices.invoiceId, invoiceId))),
  );
  return rows.length > 0;
}

async function cycleRow(t: TestTenant, cycleId: string) {
  const [row] = await runInTenant(t.ctx, (tx) =>
    tx
      .select({
        status: renewalCycles.status,
        linkedInvoiceId: renewalCycles.linkedInvoiceId,
      })
      .from(renewalCycles)
      .where(eq(renewalCycles.cycleId, cycleId)),
  );
  return row;
}

async function crossTenantProbeCount(t: TestTenant, invoiceId: string): Promise<number> {
  const rows = await runInTenant(t.ctx, (tx) =>
    tx
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, t.ctx.slug),
          eq(auditLog.eventType, 'invoice_cross_tenant_probe' as never),
        ),
      ),
  );
  return rows.filter(
    (r) => (r.payload as Record<string, unknown>).attempted_invoice_id === invoiceId,
  ).length;
}

async function discardAuditCount(
  t: TestTenant,
  invoiceId: string,
  reason: string,
): Promise<number> {
  const rows = await runInTenant(t.ctx, (tx) =>
    tx
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, t.ctx.slug),
          eq(auditLog.eventType, 'renewal_auto_draft_discarded' as never),
        ),
      ),
  );
  return rows.filter((r) => {
    const p = r.payload as Record<string, unknown>;
    return p.invoice_id === invoiceId && p.reason === reason;
  }).length;
}

async function relinkAuditCount(
  t: TestTenant,
  invoiceId: string,
): Promise<number> {
  const rows = await runInTenant(t.ctx, (tx) =>
    tx
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, t.ctx.slug),
          eq(auditLog.eventType, 'renewal_orphan_invoice_relinked' as never),
        ),
      ),
  );
  return rows.filter(
    (r) => (r.payload as Record<string, unknown>).invoice_id === invoiceId,
  ).length;
}

describe('107-auto-invoice Task 11 — prune-auto-drafts + reconcile-issued-orphans (live Neon)', () => {
  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    [tenant, tenant2, tenant3] = await Promise.all([
      createTestTenant('test'),
      createTestTenant('test'),
      createTestTenant('test'),
    ]);
    planId = `f8-t11-plan-${randomUUID().slice(0, 8)}`;
    planId2 = `f8-t11-plan2-${randomUUID().slice(0, 8)}`;
    planId3 = `f8-t11-plan3-${randomUUID().slice(0, 8)}`;
    await Promise.all([
      runInTenant(tenant.ctx, (tx) =>
        seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId,
          planYear: PLAN_YEAR,
          planName: { en: 'Task 11 Plan' },
          benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
          createdBy: user.userId,
        }),
      ),
      runInTenant(tenant2.ctx, (tx) =>
        seedF8MembershipPlan(tx, {
          tenantSlug: tenant2.ctx.slug,
          planId: planId2,
          planYear: PLAN_YEAR,
          planName: { en: 'Task 11 Plan 2' },
          benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
          createdBy: user.userId,
        }),
      ),
      runInTenant(tenant3.ctx, (tx) =>
        seedF8MembershipPlan(tx, {
          tenantSlug: tenant3.ctx.slug,
          planId: planId3,
          planYear: PLAN_YEAR,
          planName: { en: 'Task 11 Plan 3' },
          benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
          createdBy: user.userId,
        }),
      ),
    ]);
    await Promise.all([
      seedTenantFiscal({
        tenant,
        invoiceNumberPrefix: 'SC',
        receiptNumberPrefix: 'RC',
      }),
      seedTenantFiscal({
        tenant: tenant2,
        invoiceNumberPrefix: 'SC',
        receiptNumberPrefix: 'RC',
      }),
      seedTenantFiscal({
        tenant: tenant3,
        invoiceNumberPrefix: 'SC',
        receiptNumberPrefix: 'RC',
      }),
    ]);
  }, 180_000);

  afterAll(async () => {
    await Promise.all([
      tenant.cleanup().catch(() => {}),
      tenant3.cleanup().catch(() => {}),
      tenant2.cleanup().catch(() => {}),
    ]);
  }, 60_000);

  describe('pruneAutoDrafts', () => {
    it('(a1) discards a stale draft whose cycle self-renewed, emits renewal_auto_draft_discarded{reason:pruned_left_window}', async () => {
      const { cycleId, invoiceId } = await seedQueueRow(tenant, planId);
      // Simulate "member self-renewed" — a fresh confirmRenewal/issue flow
      // flips the cycle to `awaiting_payment` (via a DIFFERENT invoice),
      // leaving this cycle's ORIGINAL stamped draft stale.
      await runInTenant(tenant.ctx, (tx) =>
        tx
          .update(renewalCycles)
          .set({ status: 'awaiting_payment' })
          .where(eq(renewalCycles.cycleId, cycleId)),
      );

      const result = await pruneAutoDrafts(depsFor(tenant), {
        tenantId: tenant.ctx.slug,
        correlationId: 'integration-test-prune-a1',
      });

      expect(result.ok, result.ok ? 'ok' : JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      expect(result.value.candidatesFound).toBe(1);
      expect(result.value.pruned).toBe(1);
      expect(result.value.errors).toBe(0);
      expect(await invoiceExists(tenant, invoiceId)).toBe(false);
      expect(await discardAuditCount(tenant, invoiceId, 'pruned_left_window')).toBe(1);
    }, 90_000);

    it('(a2) idempotent — re-running finds 0 candidates (the deleted invoice drops out of the join)', async () => {
      const { cycleId, invoiceId } = await seedQueueRow(tenant, planId);
      await runInTenant(tenant.ctx, (tx) =>
        tx
          .update(renewalCycles)
          .set({ status: 'lapsed', closedAt: NOW, closedReason: 'lapsed' })
          .where(eq(renewalCycles.cycleId, cycleId)),
      );

      const first = await pruneAutoDrafts(depsFor(tenant), {
        tenantId: tenant.ctx.slug,
        correlationId: 'integration-test-prune-a2-first',
      });
      expect(first.ok).toBe(true);
      if (first.ok) expect(first.value.pruned).toBe(1);
      expect(await invoiceExists(tenant, invoiceId)).toBe(false);

      const second = await pruneAutoDrafts(depsFor(tenant), {
        tenantId: tenant.ctx.slug,
        correlationId: 'integration-test-prune-a2-second',
      });
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(second.value.candidatesFound).toBe(0);
        expect(second.value.pruned).toBe(0);
      }
    }, 90_000);

    it('(a3) throw-path — one candidate errors, the other is still pruned', async () => {
      const rowA = await seedQueueRow(tenant, planId);
      const rowB = await seedQueueRow(tenant, planId);
      await runInTenant(tenant.ctx, (tx) =>
        tx
          .update(renewalCycles)
          .set({ status: 'awaiting_payment' })
          .where(
            and(
              eq(renewalCycles.tenantId, tenant.ctx.slug),
              eq(renewalCycles.cycleId, rowA.cycleId),
            ),
          ),
      );
      await runInTenant(tenant.ctx, (tx) =>
        tx
          .update(renewalCycles)
          .set({ status: 'awaiting_payment' })
          .where(
            and(
              eq(renewalCycles.tenantId, tenant.ctx.slug),
              eq(renewalCycles.cycleId, rowB.cycleId),
            ),
          ),
      );

      const real = makeRenewalsDeps(tenant.ctx.slug, { blob: testBlob });
      const flakyBridge: typeof real.f4InvoicingBridge = {
        ...real.f4InvoicingBridge,
        discardAutoDraftForRenewal: async (input) => {
          if (input.invoiceId === rowA.invoiceId) {
            throw new Error('simulated discard failure — throw-path test');
          }
          return real.f4InvoicingBridge.discardAutoDraftForRenewal(input);
        },
      };
      const deps = { ...real, f4InvoicingBridge: flakyBridge, clock: { now: () => NOW } };

      const result = await pruneAutoDrafts(deps, {
        tenantId: tenant.ctx.slug,
        correlationId: 'integration-test-prune-a3',
      });

      expect(result.ok, result.ok ? 'ok' : JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      expect(result.value.candidatesFound).toBe(2);
      expect(result.value.errors).toBe(1);
      expect(result.value.pruned).toBe(1);
      // rowA's draft is UNTOUCHED (the throw happened before any delete).
      expect(await invoiceExists(tenant, rowA.invoiceId)).toBe(true);
      // rowB's draft WAS pruned despite rowA's failure.
      expect(await invoiceExists(tenant, rowB.invoiceId)).toBe(false);
    }, 90_000);

    it('(a4) a candidate that vanished before processing is skipped WITHOUT an invoice_cross_tenant_probe', async () => {
      const ghostInvoiceId = randomUUID();
      const ghostCycleId = randomUUID();
      const real = makeRenewalsDeps(tenant.ctx.slug, { blob: testBlob });
      const fabricatedCyclesRepo: typeof real.cyclesRepo = {
        ...real.cyclesRepo,
        listStaleAutoDrafts: async () => [
          {
            invoiceId: ghostInvoiceId,
            cycleId: ghostCycleId as never,
            memberId: randomUUID(),
          },
        ],
      };
      const deps = { ...real, cyclesRepo: fabricatedCyclesRepo, clock: { now: () => NOW } };

      const result = await pruneAutoDrafts(deps, {
        tenantId: tenant.ctx.slug,
        correlationId: 'integration-test-prune-a4',
      });

      expect(result.ok, result.ok ? 'ok' : JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      expect(result.value.candidatesFound).toBe(1);
      expect(result.value.pruned).toBe(0);
      expect(result.value.skippedAlreadyGone).toBe(1);
      expect(result.value.errors).toBe(0);
      expect(await crossTenantProbeCount(tenant, ghostInvoiceId)).toBe(0);
    }, 90_000);

    it('(a5) a candidate concurrently promoted to issued (not_draft) is skipped, not miscounted as an error', async () => {
      const { cycleId, memberId, invoiceId } = await seedQueueRow(tenant, planId);
      // The candidate LIST is forced (deterministic TOCTOU simulation,
      // independent of the real `status NOT IN (upcoming,reminded)`
      // window predicate/timing) so this test exercises the bridge's real
      // `not_draft` outcome without depending on shared-tenant state or a
      // genuine race. The real `discardAutoDraftForRenewal` call below
      // still hits live Neon.
      const real = makeRenewalsDeps(tenant.ctx.slug, { blob: testBlob });
      const forcedCandidateRepo: typeof real.cyclesRepo = {
        ...real.cyclesRepo,
        listStaleAutoDrafts: async () => [
          { invoiceId, cycleId: cycleId as never, memberId },
        ],
      };
      const deps = { ...real, cyclesRepo: forcedCandidateRepo, clock: { now: () => NOW } };

      // Concurrent promotion — a treasurer issues the SAME draft BEFORE
      // the prune cron's per-row processing reaches it (the candidate list
      // above was already computed/forced, so this mimics the row having
      // been promoted between the scan and the per-row discard call).
      const issueResult = await real.f4InvoicingBridge.issueExistingDraftForRenewal({
        tenantId: tenant.ctx.slug,
        invoiceId,
        actorUserId: user.userId,
        autoEmailOnIssue: false,
        requestId: null,
      });
      expect(issueResult.status).toBe('issued');

      const result = await pruneAutoDrafts(deps, {
        tenantId: tenant.ctx.slug,
        correlationId: 'integration-test-prune-a5',
      });

      expect(result.ok, result.ok ? 'ok' : JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      expect(result.value.candidatesFound).toBe(1);
      expect(result.value.pruned).toBe(0);
      expect(result.value.skippedAlreadyGone).toBe(1);
      expect(result.value.errors).toBe(0);
      // The now-issued invoice is untouched — the status-guarded DELETE
      // matched 0 rows.
      expect(await invoiceExists(tenant, invoiceId)).toBe(true);
    }, 90_000);
  });

  describe('reconcileIssuedOrphans', () => {
    it('(b1) re-links an issued auto-drafted invoice whose cycle was never linked', async () => {
      const { cycleId, invoiceId } = await seedQueueRow(tenant2, planId2);
      const real = makeRenewalsDeps(tenant2.ctx.slug, { blob: testBlob });
      const issueResult = await real.f4InvoicingBridge.issueExistingDraftForRenewal({
        tenantId: tenant2.ctx.slug,
        invoiceId,
        actorUserId: user.userId,
        autoEmailOnIssue: false,
        requestId: null,
      });
      expect(issueResult.status).toBe('issued');
      // The cycle was NEVER touched by tx2 — still `upcoming`, unlinked.
      const before = await cycleRow(tenant2, cycleId);
      expect(before?.status).toBe('upcoming');
      expect(before?.linkedInvoiceId).toBeNull();

      const result = await reconcileIssuedOrphans(depsFor(tenant2), {
        tenantId: tenant2.ctx.slug,
        correlationId: 'integration-test-reconcile-b1',
      });

      expect(result.ok, result.ok ? 'ok' : JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      expect(result.value.candidatesFound).toBe(1);
      expect(result.value.relinked).toBe(1);
      expect(result.value.errors).toBe(0);

      const after = await cycleRow(tenant2, cycleId);
      expect(after?.status).toBe('awaiting_payment');
      expect(after?.linkedInvoiceId).toBe(invoiceId);
      // Review Important-2 fix — the repair emits its own dedicated audit
      // row (distinct from F4's `invoice_issued`, which fired earlier).
      expect(await relinkAuditCount(tenant2, invoiceId)).toBe(1);
    }, 90_000);

    it('(b2) idempotent — re-running finds 0 candidates', async () => {
      const { cycleId, invoiceId } = await seedQueueRow(tenant2, planId2);
      const real = makeRenewalsDeps(tenant2.ctx.slug, { blob: testBlob });
      await real.f4InvoicingBridge.issueExistingDraftForRenewal({
        tenantId: tenant2.ctx.slug,
        invoiceId,
        actorUserId: user.userId,
        autoEmailOnIssue: false,
        requestId: null,
      });

      const first = await reconcileIssuedOrphans(depsFor(tenant2), {
        tenantId: tenant2.ctx.slug,
        correlationId: 'integration-test-reconcile-b2-first',
      });
      expect(first.ok).toBe(true);
      if (first.ok) expect(first.value.relinked).toBe(1);

      const second = await reconcileIssuedOrphans(depsFor(tenant2), {
        tenantId: tenant2.ctx.slug,
        correlationId: 'integration-test-reconcile-b2-second',
      });
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(second.value.candidatesFound).toBe(0);
        expect(second.value.relinked).toBe(0);
      }
      const after = await cycleRow(tenant2, cycleId);
      expect(after?.linkedInvoiceId).toBe(invoiceId);
    }, 90_000);

    it('(b3) a correctly-linked sibling pair is never touched', async () => {
      // A NORMAL, fully-issued-and-linked queue row (the happy path,
      // exactly what `issueAutoDraftedRenewal`'s tx2 produces).
      const linked = await seedQueueRow(tenant2, planId2);
      const real = makeRenewalsDeps(tenant2.ctx.slug, { blob: testBlob });
      const issueResult = await real.f4InvoicingBridge.issueExistingDraftForRenewal({
        tenantId: tenant2.ctx.slug,
        invoiceId: linked.invoiceId,
        actorUserId: user.userId,
        autoEmailOnIssue: false,
        requestId: null,
      });
      expect(issueResult.status).toBe('issued');
      await runInTenant(tenant2.ctx, (tx) =>
        tx
          .update(renewalCycles)
          .set({ status: 'awaiting_payment', linkedInvoiceId: linked.invoiceId })
          .where(eq(renewalCycles.cycleId, linked.cycleId)),
      );

      // Plus a genuine orphan sibling — proves the query is selective and
      // doesn't collaterally touch the already-linked row while fixing the
      // orphaned one.
      const orphan = await seedQueueRow(tenant2, planId2);
      await real.f4InvoicingBridge.issueExistingDraftForRenewal({
        tenantId: tenant2.ctx.slug,
        invoiceId: orphan.invoiceId,
        actorUserId: user.userId,
        autoEmailOnIssue: false,
        requestId: null,
      });

      const result = await reconcileIssuedOrphans(depsFor(tenant2), {
        tenantId: tenant2.ctx.slug,
        correlationId: 'integration-test-reconcile-b3',
      });

      expect(result.ok, result.ok ? 'ok' : JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      // Only the orphan is a candidate — the pre-linked row never appears.
      expect(result.value.candidatesFound).toBe(1);
      expect(result.value.relinked).toBe(1);

      const linkedAfter = await cycleRow(tenant2, linked.cycleId);
      expect(linkedAfter?.status).toBe('awaiting_payment');
      expect(linkedAfter?.linkedInvoiceId).toBe(linked.invoiceId);
      const orphanAfter = await cycleRow(tenant2, orphan.cycleId);
      expect(orphanAfter?.linkedInvoiceId).toBe(orphan.invoiceId);
    }, 90_000);

    it('(b4) a cycle that lapsed before the link could be repaired is left alone (skippedTerminal)', async () => {
      const { cycleId, invoiceId } = await seedQueueRow(tenant2, planId2);
      const real = makeRenewalsDeps(tenant2.ctx.slug, { blob: testBlob });
      await real.f4InvoicingBridge.issueExistingDraftForRenewal({
        tenantId: tenant2.ctx.slug,
        invoiceId,
        actorUserId: user.userId,
        autoEmailOnIssue: false,
        requestId: null,
      });
      // The grace-expiry cron lapses the cycle BEFORE reconcile gets to it —
      // an extreme edge case (the bill is real; a lapsed member's own bill
      // should not be force-relinked/re-activated by a housekeeping sweep).
      await runInTenant(tenant2.ctx, (tx) =>
        tx
          .update(renewalCycles)
          .set({ status: 'lapsed', closedAt: NOW, closedReason: 'lapsed' })
          .where(eq(renewalCycles.cycleId, cycleId)),
      );

      const result = await reconcileIssuedOrphans(depsFor(tenant2), {
        tenantId: tenant2.ctx.slug,
        correlationId: 'integration-test-reconcile-b4',
      });

      expect(result.ok, result.ok ? 'ok' : JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      expect(result.value.candidatesFound).toBe(1);
      expect(result.value.relinked).toBe(0);
      expect(result.value.skippedTerminal).toBe(1);

      const after = await cycleRow(tenant2, cycleId);
      expect(after?.status).toBe('lapsed');
      expect(after?.linkedInvoiceId).toBeNull();
    }, 90_000);

    it('(b5) review Important-1 — an invoice voided between the scan and the write is never linked (skippedInvoiceNotIssued)', async () => {
      // Own tenant (`tenant3`): (b4)'s terminal-skipped orphan is a
      // PERMANENT leftover in `tenant2`'s candidate pool (it can never
      // self-heal — the cycle is closed) and would otherwise inflate this
      // test's `candidatesFound`.
      const { cycleId, memberId, invoiceId } = await seedQueueRow(tenant3, planId3);
      const real = makeRenewalsDeps(tenant3.ctx.slug, { blob: testBlob });
      const issueResult = await real.f4InvoicingBridge.issueExistingDraftForRenewal({
        tenantId: tenant3.ctx.slug,
        invoiceId,
        actorUserId: user.userId,
        autoEmailOnIssue: false,
        requestId: null,
      });
      expect(issueResult.status).toBe('issued');

      // The candidate LIST is forced (deterministic TOCTOU simulation,
      // mirrors `pruneAutoDrafts`'s (a5) test) — voiding for real BEFORE
      // calling reconcile would make the real `listIssuedAutoInvoiceOrphans`
      // query exclude the row outright (`status <> 'issued'`), which tests
      // "already voided at scan time", NOT "voided in the window BETWEEN
      // the scan and the write". Forcing the candidate list lets this test
      // exercise the real in-tx re-check against a genuinely voided DB row.
      const forcedCandidateRepo: typeof real.cyclesRepo = {
        ...real.cyclesRepo,
        listIssuedAutoInvoiceOrphans: async () => [
          { invoiceId, cycleId: cycleId as never, memberId },
        ],
      };
      const deps = { ...real, cyclesRepo: forcedCandidateRepo };

      // Simulate an admin voiding the orphan invoice in the window between
      // the (forced) candidate scan and the reconcile write — direct DB
      // write since no F4 void use-case is exercised in this suite.
      await runInTenant(tenant3.ctx, (tx) =>
        tx
          .update(invoices)
          .set({
            status: 'void',
            voidedAt: NOW,
            voidReason: 'integration-test-b5-simulated-void',
            voidedByUserId: user.userId,
          })
          .where(eq(invoices.invoiceId, invoiceId)),
      );

      const result = await reconcileIssuedOrphans(deps, {
        tenantId: tenant3.ctx.slug,
        correlationId: 'integration-test-reconcile-b5',
      });

      expect(result.ok, result.ok ? 'ok' : JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      expect(result.value.candidatesFound).toBe(1);
      expect(result.value.relinked).toBe(0);
      expect(result.value.skippedInvoiceNotIssued).toBe(1);
      expect(result.value.errors).toBe(0);

      // Never linked — the cycle stays exactly as it was before reconcile.
      const after = await cycleRow(tenant3, cycleId);
      expect(after?.status).toBe('upcoming');
      expect(after?.linkedInvoiceId).toBeNull();
      expect(await relinkAuditCount(tenant3, invoiceId)).toBe(0);
    }, 90_000);

    it('(b6) review Minor — a CycleTransitionConflictError on the upcoming/reminded branch is bucketed as skippedConflict, not errors', async () => {
      // Own tenant (`tenant3`): keeps this test independent of (b5)'s
      // fixture and (b4)'s permanent leftover in `tenant2`.
      const { cycleId, invoiceId } = await seedQueueRow(tenant3, planId3);
      const real = makeRenewalsDeps(tenant3.ctx.slug, { blob: testBlob });
      const issueResult = await real.f4InvoicingBridge.issueExistingDraftForRenewal({
        tenantId: tenant3.ctx.slug,
        invoiceId,
        actorUserId: user.userId,
        autoEmailOnIssue: false,
        requestId: null,
      });
      expect(issueResult.status).toBe('issued');

      const flakyCyclesRepo: typeof real.cyclesRepo = {
        ...real.cyclesRepo,
        transitionStatus: async (tx, tid, cid, args) => {
          if (cid === cycleId) {
            throw new CycleTransitionConflictError(
              cycleId,
              'upcoming',
              'awaiting_payment',
            );
          }
          return real.cyclesRepo.transitionStatus(tx, tid, cid, args);
        },
      };
      const deps = { ...real, cyclesRepo: flakyCyclesRepo };

      const result = await reconcileIssuedOrphans(deps, {
        tenantId: tenant3.ctx.slug,
        correlationId: 'integration-test-reconcile-b6',
      });

      expect(result.ok, result.ok ? 'ok' : JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      expect(result.value.candidatesFound).toBe(1);
      expect(result.value.relinked).toBe(0);
      expect(result.value.skippedConflict).toBe(1);
      expect(result.value.errors).toBe(0);

      // Never linked — the simulated conflict rolled back the whole tx
      // (transitionStatus threw before the audit emit could run).
      const after = await cycleRow(tenant3, cycleId);
      expect(after?.linkedInvoiceId).toBeNull();
      expect(await relinkAuditCount(tenant3, invoiceId)).toBe(0);
    }, 90_000);
  });
});
