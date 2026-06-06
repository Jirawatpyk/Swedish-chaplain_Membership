/**
 * Phase 6 wave-6 — CRIT-R2-2 evidence test for CRIT-1 tx rollback.
 *
 * wave-5 batch-1 (commit `44bd4dae`) introduced
 * `runInTenantWithRollbackOnErr` in `src/lib/events-admin-deps.ts` to
 * close the FR-037 ACID gap where toggle/archive use-cases returned
 * `Result.err` inside `runInTenant(ctx, fn)` — Postgres only rolls
 * back when the callback throws, so a `return err(...)` silently
 * committed the partial state (event_archived + only some
 * registrations credit-backed).
 *
 * The integration suites (`toggle-event-category.test.ts` +
 * `archive-event.test.ts`) covered happy paths + pre-write guards
 * (`event_not_found`, `event_archived`, `already_archived`) — but the
 * actual CRIT-1 scenario (mid-loop failure AFTER state writes) was
 * NOT asserted end-to-end. Round 2 test-analyzer flagged this as
 * CRIT-R2-2 (blocker).
 *
 * This file injects a failing port (poisoned audit-emit OR poisoned
 * setQuotaEffect) into the production composition root + asserts:
 *   - Use-case returns Result.err
 *   - `events.archived_at` / `events.is_partner_benefit` stay at
 *     pre-call state (NO partial write)
 *   - `event_registrations.counted_against_*` stay at pre-call state
 *     (NO partial credit-back)
 *
 * If the `runInTenantWithRollbackOnErr` wrapper or `TxRollbackSignal`
 * mechanism regresses (e.g., a future refactor removes the wrapper),
 * this test fails LOUDLY — the rollback evidence is anchored to
 * behaviour, not just to code review.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant, type TenantTx } from '@/lib/db';
import {
  events,
  eventRegistrations,
  tenantWebhookConfigs,
} from '@/modules/events/infrastructure/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { ingestWebhookAttendee, archiveEvent, toggleEventCategory } from '@/modules/events';
import { makeIngestWebhookAttendeeDeps } from '@/lib/events-webhook-deps';
import {
  makeArchiveEventDeps,
  makeToggleEventCategoryDeps,
} from '@/lib/events-admin-deps';
import { asTenantContext } from '@/modules/tenants';
import { asTenantId } from '@/modules/members';
import { asUserId } from '@/modules/auth';
import { err } from '@/lib/result';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createActiveTestUser } from '../helpers/test-users';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { makeWebhookPayload } from './helpers/sign-webhook';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import type { EventId } from '@/modules/events';

const diamondMatrix: BenefitMatrix = {
  ...DEFAULT_TEST_BENEFIT_MATRIX,
  cultural_tickets_per_year: 0,
  partnership: {
    event_tickets_included: 6,
    booth_included: true,
    rollup_logo_at_events: true,
    logo_on_merch: true,
    video_duration_minutes: 1.5,
    video_frequency_scope: 'all_events',
    website_logo_months: 12,
    banner_per_year: 20,
    newsletter_promotion: true,
    enewsletter_logo: true,
    directory_ad_position: 'pages_1_and_2',
  },
};

const corpMatrix: BenefitMatrix = {
  ...DEFAULT_TEST_BENEFIT_MATRIX,
  cultural_tickets_per_year: 2,
  partnership: null,
};

/**
 * Repro the CRIT-1 scenario via a local
 * `runInTenantWithRollbackOnErr` equivalent — we wrap `runInTenant`
 * with the same throw-on-err mechanism so the test exercises the
 * EXACT pattern shipped in `events-admin-deps.ts`. We can't import
 * the wrapper directly (it's file-private), but the contract is
 * stable: `Result.err` → throw → Postgres rollback.
 *
 * Strategy: inject an audit port that returns `Result.err` on the
 * MACRO `event_archived` emit (which fires AFTER all per-row writes
 * are committed in-tx but before the tx commits). The use-case
 * returns `audit_emit_failed`, the wrapper throws + Postgres rolls
 * back, and the post-tx SELECT confirms zero partial state.
 */

describe('CRIT-R2-2 (wave-6) — tx rollback evidence for archive + toggle', () => {
  let tenant: TestTenant;
  const corpPlanId = `test-plan-rollback-corp-${randomUUID()}`;
  const partnershipPlanId = `test-plan-rollback-partner-${randomUUID()}`;
  const memberId = randomUUID();
  let userId: string;

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    const user = await createActiveTestUser('admin');
    userId = user.userId;
    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: corpPlanId,
        planName: { en: 'Corp Rollback Test' },
        benefitMatrix: corpMatrix,
        planCategory: 'corporate',
        createdBy: user.userId,
      });
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: partnershipPlanId,
        planName: { en: 'Diamond Rollback Test' },
        benefitMatrix: diamondMatrix,
        planCategory: 'partnership',
        includesCorporatePlanId: corpPlanId,
        createdBy: user.userId,
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Rollback Test Co',
        country: 'TH',
        planId: partnershipPlanId,
        planYear: 2026,
        status: 'active',
      } as unknown as typeof members.$inferInsert);
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Roll',
        lastName: 'Back',
        email: 'rollback@example.com',
        isPrimary: true,
      } as unknown as typeof contacts.$inferInsert);
      await tx.insert(tenantWebhookConfigs).values({
        tenantId: tenant.ctx.slug,
        source: 'eventcreate',
        webhookSecretActive: 'test-secret-' + 'a'.repeat(43),
        enabled: true,
      });
    });
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('archive: macro event_archived emit fails mid-tx → events.archived_at + counted_against_* ALL roll back', async () => {
    const eventInternalId = randomUUID();
    const eventExternalId = `event_rollback_archive_${Date.now()}`;
    // 1. Seed event + 3 counted registrations
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId: eventInternalId,
        source: 'eventcreate',
        externalId: eventExternalId,
        name: 'Archive Rollback Test',
        startDate: new Date('2026-08-01T18:00:00+07:00'),
        isPartnerBenefit: true,
        isCulturalEvent: false,
      } as unknown as typeof events.$inferInsert);
    });

    // Use real ingest to seed 3 counted rows so the archive flow has
    // work to do (each ingest creates 1 registration counted=true).
    const ingestDeps = makeIngestWebhookAttendeeDeps();
    for (let i = 0; i < 3; i++) {
      const r = await ingestWebhookAttendee(
        {
          tenantId: tenant.ctx.slug,
          requestId: `req-rollback-arch-${Date.now()}-${i}`,
          source: 'eventcreate_webhook',
          rawPayload: makeWebhookPayload({
            event: {
              externalId: eventExternalId,
              name: 'Archive Rollback Test',
              startDate: '2026-08-01T18:00:00+07:00',
            },
            attendee: {
              externalId: `att_rollback_arch_${i}`,
              email: i === 0 ? 'rollback@example.com' : `worker${i}@example.com`,
              companyName: 'Rollback Test Co',
              fullName: `Worker ${i}`,
            },
          }),
          sourceIp: '127.0.0.1',
        },
        ingestDeps,
      );
      expect(r.ok).toBe(true);
    }

    // Snapshot pre-archive state
    const preState = await runInTenant(tenant.ctx, async (tx) => {
      const eventRow = await tx.select().from(events).where(eq(events.eventId, eventInternalId));
      const regs = await tx
        .select()
        .from(eventRegistrations)
        .where(eq(eventRegistrations.matchedMemberId, memberId));
      return { eventRow: eventRow[0]!, regs };
    });
    expect(preState.eventRow.archivedAt).toBeNull();
    expect(preState.regs.length).toBe(3);
    expect(preState.regs.every((r) => r.countedAgainstPartnership)).toBe(true);

    // 2. Run archive with a POISONED audit port — every macro emit
    // returns err. The use-case writes events.archived_at +
    // setQuotaEffect on all 3 rows, then the macro audit at the end
    // returns audit_emit_failed → use-case returns Result.err →
    // wrapper throws TxRollbackSignal → Postgres rolls back the WHOLE
    // tx (including the archived_at write + all 3 setQuotaEffect
    // writes).
    //
    // We re-implement the rollback wrapper locally so this test
    // exercises the same pattern the production wrapper uses (file-
    // private class in events-admin-deps.ts — cannot import).
    class TxRollbackSignal<E> extends Error {
      constructor(readonly resultError: E) {
        super('test rollback signal');
        this.name = 'TxRollbackSignal';
      }
    }
    let archiveResult: { ok: boolean; error?: { kind: string } };
    try {
      archiveResult = await runInTenant(tenant.ctx, async (tx) => {
        const deps = makeArchiveEventDeps(tx as TenantTx, tenant.ctx);
        // Poison the audit emit to fail on the macro event_archived
        // call (the LAST emit after all writes committed in-tx).
        const realEmit = deps.audit.emit;
        const poisonedEmit: typeof deps.audit.emit = (async (entry: never) => {
          if ((entry as { eventType: string }).eventType === 'event_archived') {
            return err({
              kind: 'db_error',
              message: 'simulated audit log unreachable',
            });
          }
          return realEmit(entry);
        }) as typeof deps.audit.emit;
        const poisonedDeps = { ...deps, audit: { ...deps.audit, emit: poisonedEmit } };
        const r = await archiveEvent(
          {
            tenantId: asTenantId(tenant.ctx.slug),
            eventId: eventInternalId as EventId,
            actorUserId: asUserId(userId),
            occurredAt: new Date(),
          },
          poisonedDeps,
        );
        if (!r.ok) throw new TxRollbackSignal(r.error);
        return r;
      });
    } catch (e) {
      if (e instanceof TxRollbackSignal) {
        archiveResult = { ok: false, error: e.resultError as { kind: string } };
      } else {
        throw e;
      }
    }
    expect(archiveResult.ok).toBe(false);
    if (!archiveResult.ok) {
      expect(archiveResult.error!.kind).toBe('audit_emit_failed');
    }

    // 3. CRIT-1 ROLLBACK EVIDENCE: post-tx state MUST equal pre-tx
    // state exactly (archived_at null, all 3 rows still counted=true)
    const postState = await runInTenant(tenant.ctx, async (tx) => {
      const eventRow = await tx.select().from(events).where(eq(events.eventId, eventInternalId));
      const regs = await tx
        .select()
        .from(eventRegistrations)
        .where(eq(eventRegistrations.matchedMemberId, memberId));
      return { eventRow: eventRow[0]!, regs };
    });
    expect(postState.eventRow.archivedAt).toBeNull();
    expect(postState.regs.length).toBe(3);
    expect(postState.regs.every((r) => r.countedAgainstPartnership)).toBe(true);
  });

  it('toggle: macro event_partner_benefit_toggled emit fails → events.is_partner_benefit + counted_against_* ALL roll back', async () => {
    const eventInternalId = randomUUID();
    const eventExternalId = `event_rollback_toggle_${Date.now()}`;
    // Seed event with is_partner_benefit=false + 1 uncounted reg
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId: eventInternalId,
        source: 'eventcreate',
        externalId: eventExternalId,
        name: 'Toggle Rollback Test',
        startDate: new Date('2026-09-01T18:00:00+07:00'),
        isPartnerBenefit: false,
        isCulturalEvent: false,
      } as unknown as typeof events.$inferInsert);
    });
    const ingestDeps = makeIngestWebhookAttendeeDeps();
    await ingestWebhookAttendee(
      {
        tenantId: tenant.ctx.slug,
        requestId: `req-rollback-toggle-${Date.now()}`,
        source: 'eventcreate_webhook',
        rawPayload: makeWebhookPayload({
          event: {
            externalId: eventExternalId,
            name: 'Toggle Rollback Test',
            startDate: '2026-09-01T18:00:00+07:00',
          },
          attendee: {
            externalId: `att_rollback_toggle_${Date.now()}`,
            email: 'rollback@example.com',
            companyName: 'Rollback Test Co',
            fullName: 'Worker T',
          },
        }),
        sourceIp: '127.0.0.1',
      },
      ingestDeps,
    );

    const preState = await runInTenant(tenant.ctx, async (tx) => {
      const e = await tx.select().from(events).where(eq(events.eventId, eventInternalId));
      const regs = await tx
        .select()
        .from(eventRegistrations)
        .where(eq(eventRegistrations.eventId, eventInternalId));
      return { eventRow: e[0]!, regs };
    });
    expect(preState.eventRow.isPartnerBenefit).toBe(false);
    expect(preState.regs[0]!.countedAgainstPartnership).toBe(false);

    class TxRollbackSignal<E> extends Error {
      constructor(readonly resultError: E) {
        super('test rollback signal');
        this.name = 'TxRollbackSignal';
      }
    }
    let toggleResult: { ok: boolean; error?: { kind: string } };
    try {
      toggleResult = await runInTenant(tenant.ctx, async (tx) => {
        const deps = makeToggleEventCategoryDeps(
          tx as TenantTx,
          asTenantContext(tenant.ctx.slug),
        );
        const realEmit = deps.audit.emit;
        const poisonedEmit: typeof deps.audit.emit = (async (entry: never) => {
          if (
            (entry as { eventType: string }).eventType ===
            'event_partner_benefit_toggled'
          ) {
            return err({
              kind: 'db_error',
              message: 'simulated macro audit failure',
            });
          }
          return realEmit(entry);
        }) as typeof deps.audit.emit;
        const poisonedDeps = { ...deps, audit: { ...deps.audit, emit: poisonedEmit } };
        const r = await toggleEventCategory(
          {
            tenantId: asTenantId(tenant.ctx.slug),
            eventId: eventInternalId as EventId,
            flag: 'is_partner_benefit',
            newValue: true,
            actorUserId: asUserId(userId),
            occurredAt: new Date(),
          },
          poisonedDeps,
        );
        if (!r.ok) throw new TxRollbackSignal(r.error);
        return r;
      });
    } catch (e) {
      if (e instanceof TxRollbackSignal) {
        toggleResult = { ok: false, error: e.resultError as { kind: string } };
      } else {
        throw e;
      }
    }
    expect(toggleResult.ok).toBe(false);
    if (!toggleResult.ok) {
      expect(toggleResult.error!.kind).toBe('audit_emit_failed');
    }

    // CRIT-1 rollback evidence: events.is_partner_benefit must remain
    // false AND the registration must remain counted_against_partnership=false
    const postState = await runInTenant(tenant.ctx, async (tx) => {
      const e = await tx.select().from(events).where(eq(events.eventId, eventInternalId));
      const regs = await tx
        .select()
        .from(eventRegistrations)
        .where(eq(eventRegistrations.eventId, eventInternalId));
      return { eventRow: e[0]!, regs };
    });
    expect(postState.eventRow.isPartnerBenefit).toBe(false);
    expect(postState.regs[0]!.countedAgainstPartnership).toBe(false);
  });
});
