/**
 * 066 Round-2 §3.2(2) — due-track dispatch invariants (live Neon).
 *
 * One tenant, seven per-case members/cycles; assertions are keyed per
 * cycleId (DB rows + gateway call args) so the whole-tenant cron pass
 * can't cross-talk between cases.
 *
 * Geometry rule (review C1): born-awaiting cycles use expiresAt ~12 months
 * out — OUTSIDE the main arm's ±120d window — so these sends can only come
 * from the second candidate arm.
 *
 * No-spam policy pinned here: only the MOST-SEVERE unsent due step fires
 * per pass (cold start past due+30 sends ONLY due+30.email; due+7 is
 * superseded, never sent after the firm warning).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { renewalReminderEvents } from '@/modules/renewals/infrastructure/schema-renewal-reminder-events';
import { renewalEscalationTasks } from '@/modules/renewals/infrastructure/schema-renewal-escalation-tasks';
import { dispatchRenewalCycle, makeRenewalsDeps } from '@/modules/renewals';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
function dateOnly(msFromNow: number): string {
  return new Date(Date.now() + msFromNow).toISOString().slice(0, 10);
}

const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'Due Dispatch Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'due-dispatch@example.com',
};

interface CaseIds {
  memberId: string;
  cycleId: string;
}
function ids(): CaseIds {
  return { memberId: randomUUID(), cycleId: randomUUID() };
}

describe('066 due-track dispatch pass (live Neon)', () => {
  let tenantA: TestTenant;
  let user: TestUser;
  let planId: string;

  // A — born-awaiting past due+7 (gentle rung fires)
  const caseA = ids();
  // B — cold start past due+30 (ONLY the firm rung fires)
  const caseB = ids();
  // C — opted-out member (contractual-notice bypass: still fires)
  const caseC = ids();
  // D — email_unverified (skipped: no send)
  const caseD = ids();
  // E — renewer w/ bill, expires in window (t+N EMAIL suppressed; task kept)
  const caseE = ids();
  // F — no-bill awaiting cycle expiring today (t+0.email ladder unaffected)
  const caseF = ids();
  // H — same geometry as F but WITH a bill: the t+0.email is suppressed
  // (converse pair F/H pins the suppression on the exact same step).
  const caseH = ids();
  // G — >365d-stuck cycle (year_in_cycle anchored on the step due-day)
  const caseG = ids();

  let seq = 920_000;
  function bill(memberId: string, dueDate: string) {
    seq += 1;
    return {
      tenantId: tenantA.ctx.slug,
      invoiceId: randomUUID(),
      memberId,
      planYear: 2026,
      planId,
      draftByUserId: user.userId,
      status: 'issued' as const,
      dueDate,
      pdfDocKind: 'invoice' as const,
      fiscalYear: 2026,
      sequenceNumber: seq,
      documentNumber: `INV-2026-${seq}`,
      issueDate: dateOnly(-450 * MS_PER_DAY),
      currency: 'THB' as const,
      subtotalSatang: 5_000_000n,
      vatRateSnapshot: '0.0700',
      vatSatang: 350_000n,
      totalSatang: 5_350_000n,
      creditedTotalSatang: 0n,
      proRatePolicySnapshot: 'none',
      netDaysSnapshot: 30,
      tenantIdentitySnapshot: SNAP_TENANT,
      memberIdentitySnapshot: SNAP_MEMBER,
      pdfBlobKey: `invoicing/${tenantA.ctx.slug}/2026/${seq}.pdf`,
      pdfSha256: 'c'.repeat(64),
      pdfTemplateVersion: 1,
    };
  }

  function cycle(
    c: CaseIds,
    opts: { periodFromMs: number; expiresMs: number },
  ) {
    return {
      tenantId: tenantA.ctx.slug,
      cycleId: c.cycleId,
      memberId: c.memberId,
      status: 'awaiting_payment' as const,
      periodFrom: new Date(Date.now() + opts.periodFromMs),
      periodTo: new Date(Date.now() + opts.expiresMs),
      expiresAt: new Date(Date.now() + opts.expiresMs),
      cycleLengthMonths: 12,
      tierAtCycleStart: 'regular' as const,
      planIdAtCycleStart: randomUUID(),
      frozenPlanPriceThb: '50000.00',
      frozenPlanTermMonths: 12,
      frozenPlanCurrency: 'THB' as const,
    };
  }

  async function seedMember(
    c: CaseIds,
    name: string,
    opts?: { optedOut?: boolean; emailUnverified?: boolean },
  ) {
    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenantA.ctx.slug,
        memberId: c.memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: name,
        country: 'TH',
        planId,
        planYear: 2026,
        ...(opts?.optedOut ? { renewalRemindersOptedOut: true } : {}),
        ...(opts?.emailUnverified ? { emailUnverified: true } : {}),
      });
      await tx.insert(contacts).values({
        tenantId: tenantA.ctx.slug,
        contactId: randomUUID(),
        memberId: c.memberId,
        firstName: 'Anna',
        lastName: 'Due',
        email: `due-${randomUUID().slice(0, 8)}@acme.example`,
        isPrimary: true,
        preferredLanguage: 'en',
      });
    });
  }

  async function reminderRows(cycleId: string) {
    return runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(renewalReminderEvents)
        .where(
          and(
            eq(renewalReminderEvents.tenantId, tenantA.ctx.slug),
            eq(renewalReminderEvents.cycleId, cycleId),
          ),
        ),
    );
  }

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant('test-swecham');
    await seedRenewalPolicies(tenantA.ctx);
    planId = `f8-duedis-${randomUUID().slice(0, 8)}`;

    await runInTenant(tenantA.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenantA.ctx.slug,
        planId,
        planName: { en: 'Due Dispatch Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );

    await seedMember(caseA, 'Case A Born Awaiting Co');
    await seedMember(caseB, 'Case B Cold Start Co');
    await seedMember(caseC, 'Case C Opted Out Co', { optedOut: true });
    await seedMember(caseD, 'Case D Unverified Co', { emailUnverified: true });
    await seedMember(caseE, 'Case E Renewer Co');
    await seedMember(caseF, 'Case F No Bill Co');
    await seedMember(caseG, 'Case G Stuck Co');
    await seedMember(caseH, 'Case H Suppressed Co');

    const BORN = { periodFromMs: -10 * MS_PER_DAY, expiresMs: 360 * MS_PER_DAY };
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(renewalCycles).values([
        cycle(caseA, BORN),
        cycle(caseB, BORN),
        cycle(caseC, BORN),
        cycle(caseD, BORN),
        // E: renewer — 12-month period that expired 7 days ago (inside the
        // main arm's window, so both arms can see it).
        cycle(caseE, { periodFromMs: -372 * MS_PER_DAY, expiresMs: -7 * MS_PER_DAY }),
        // F/H converse pair: cycle expiring TODAY → the regular ladder's
        // t+0.email is due (the only post-expiry EMAIL step on this tier).
        cycle(caseF, { periodFromMs: -365 * MS_PER_DAY, expiresMs: 0 }),
        cycle(caseH, { periodFromMs: -365 * MS_PER_DAY, expiresMs: 0 }),
        // G: stuck awaiting >365d.
        cycle(caseG, { periodFromMs: -400 * MS_PER_DAY, expiresMs: -35 * MS_PER_DAY }),
      ]),
    );

    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(invoices).values([
        bill(caseA.memberId, dateOnly(-10 * MS_PER_DAY)), // due+7 reached, due+30 not
        bill(caseB.memberId, dateOnly(-40 * MS_PER_DAY)), // cold start past due+30
        bill(caseC.memberId, dateOnly(-10 * MS_PER_DAY)),
        bill(caseD.memberId, dateOnly(-10 * MS_PER_DAY)),
        bill(caseE.memberId, dateOnly(-37 * MS_PER_DAY)), // due ≈ expiry-30d+net30
        bill(caseG.memberId, dateOnly(-380 * MS_PER_DAY)), // step due-day ≈ now-350d
        bill(caseH.memberId, dateOnly(-37 * MS_PER_DAY)), // due+30 reached
        // F deliberately has NO bill (ladder cohort).
      ]),
    );
  }, 180_000);

  afterAll(async () => {
    for (const table of [
      renewalReminderEvents,
      renewalEscalationTasks,
      invoices,
      renewalCycles,
      contacts,
      members,
      auditLog,
    ] as const) {
      await db
        .delete(table)
        .where(eq(table.tenantId, tenantA.ctx.slug))
        .catch(() => {});
    }
    await tenantA.cleanup().catch(() => {});
  }, 120_000);

  it('pass 1 — due-track sends, gates, suppression, year anchoring', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const gatewaySpy = vi
      .spyOn(deps.renewalGateway, 'sendRenewalEmail')
      .mockResolvedValue({
        ok: true,
        value: {
          deliveryId: `mock-${randomUUID().slice(0, 8)}`,
          dispatchedAt: new Date().toISOString(),
        },
      } as never);

    const r1 = await dispatchRenewalCycle(deps, {
      tenantId: tenantA.ctx.slug,
      correlationId: randomUUID(),
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    // A — gentle rung only.
    const rowsA = await reminderRows(caseA.cycleId);
    expect(rowsA.map((r) => r.stepId)).toEqual(['due+7.email']);
    expect(rowsA[0]!.status).toBe('sent');
    expect(rowsA[0]!.templateId).toBe('due-track');

    // B — cold start: ONLY the firm rung (no-spam supersede policy).
    const rowsB = await reminderRows(caseB.cycleId);
    expect(rowsB.map((r) => r.stepId)).toEqual(['due+30.email']);

    // C — opt-out bypass: contractual dunning still sent.
    const rowsC = await reminderRows(caseC.cycleId);
    expect(rowsC.map((r) => r.stepId)).toEqual(['due+7.email']);
    expect(rowsC[0]!.status).toBe('sent');

    // D — unverified email: nothing sent.
    expect(await reminderRows(caseD.cycleId)).toHaveLength(0);

    // E — due-track serves the dunning; task-channel escalations still run.
    const rowsE = await reminderRows(caseE.cycleId);
    const stepIdsE = rowsE.map((r) => r.stepId);
    expect(stepIdsE).toContain('due+30.email');
    expect(stepIdsE.filter((s) => /\.email$/.test(s) && !s.startsWith('due+'))).toHaveLength(0);
    const taskRowsE = rowsE.filter((r) => r.channel === 'task');
    expect(taskRowsE.length).toBeGreaterThan(0);

    // F/H converse pair — same geometry (expires today, t+0.email due):
    // F (no bill) fires the ladder email; H (bill) has it SUPPRESSED and
    // gets the due-track warning instead.
    const rowsF = await reminderRows(caseF.cycleId);
    expect(rowsF.map((r) => r.stepId)).toContain('t+0.email');
    const rowsH = await reminderRows(caseH.cycleId);
    expect(rowsH.map((r) => r.stepId)).toEqual(['due+30.email']);

    // G — year_in_cycle anchored on the STEP due-day (year 1), never the
    // run date (which would be year 2 at 400d after period_from).
    const rowsG = await reminderRows(caseG.cycleId);
    const g30 = rowsG.find((r) => r.stepId === 'due+30.email');
    expect(g30).toBeDefined();
    expect(g30!.yearInCycle).toBe(1);

    // Summary + gateway shape: 6 due-track sends (A,B,C,E,G,H).
    expect(r1.value.summary.dueTrackEmailsSent).toBe(6);
    const dueTrackCalls = gatewaySpy.mock.calls.filter(([input]) =>
      String(input.stepId).startsWith('due+'),
    );
    expect(dueTrackCalls).toHaveLength(6);
    for (const [input] of dueTrackCalls) {
      expect(input.templateId).toBe('due-track');
    }
  }, 120_000);

  it('pass 2 — idempotent replay: zero new due-track sends', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const gatewaySpy = vi
      .spyOn(deps.renewalGateway, 'sendRenewalEmail')
      .mockResolvedValue({
        ok: true,
        value: {
          deliveryId: `mock-${randomUUID().slice(0, 8)}`,
          dispatchedAt: new Date().toISOString(),
        },
      } as never);

    const r2 = await dispatchRenewalCycle(deps, {
      tenantId: tenantA.ctx.slug,
      correlationId: randomUUID(),
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.summary.dueTrackEmailsSent).toBe(0);
    // Every due-track cycle from pass 1 replays as already_sent.
    expect(r2.value.summary.skipped.already_sent).toBeGreaterThanOrEqual(5);
    const dueTrackCalls = gatewaySpy.mock.calls.filter(([input]) =>
      String(input.stepId).startsWith('due+'),
    );
    expect(dueTrackCalls).toHaveLength(0);

    // Row counts unchanged for the pure due-track cohort.
    expect(await reminderRows(caseA.cycleId)).toHaveLength(1);
    expect(await reminderRows(caseB.cycleId)).toHaveLength(1);
  }, 120_000);
});
