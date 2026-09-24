/**
 * F119 T149 (owner) · T150 · T152a (extends) — the `FEATURE_EBLAST_MEMBER_APPROVAL`
 * flag matrix (US7-AS1/AS3, FR-034, research R18). The RED for T152.
 *
 * The flag gates exactly ONE edge — `submitted → in_design`, the single entry
 * into the approval round — and it is read on the status the use case
 * RE-READS under the row lock, never from the request. With the flag off, a
 * row already inside the round stays completable: re-opening a working copy
 * from `changes_requested`, `member_approved` or `approved` (round ≥ 1) is an
 * exit-side write, and gating it would leave the row only cancellable
 * (`/speckit.analyze` round 3 H1).
 *
 * Every arm runs the REAL `startFormattedVersion` / `saveFormattedVersion`
 * through the route; `harness.flagOn` stands in for the composition root's
 * `isEblastMemberApprovalEnabled()` read. The send (T059) and schedule (T060)
 * arms run the REAL use cases through their routes; so does the "decided" arm
 * (T078, `POST /api/broadcasts/[id]/decision` — a member route, so the
 * portal session is `memberCtx()`).
 *
 * T149a / T152a — the drainer arm of the flag: the REAL outbox-dispatch `GET`
 * runs over a `@/lib/db` that captures the candidate SELECT's WHERE, rendered
 * through drizzle's `PgDialect`, so the test reads the exclusions the route
 * actually expressed in SQL. The row-state half (pending, attempts 0, no
 * `last_error`, then sent after the flip) runs on live Neon in
 * `tests/integration/broadcasts/eblast-send-and-promote.test.ts`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { notificationTypeEnum } from '@/modules/auth/infrastructure/db/schema';
import type { Broadcast } from '@/modules/broadcasts/domain/broadcast';
import { makeApprovalBroadcast, makeApprovalVersion } from '../../helpers/eblast-approval-fakes';
import {
  harness,
  importDecisionRoute,
  importScheduleRoute,
  importSendRoute,
  importVersionRoute,
  patchVersionRequest,
  postDecisionRequest,
  postScheduleRequest,
  postSendRequest,
  postVersionRequest,
  resetVersionHarness,
  routeParams,
} from '../../helpers/eblast-version-route-harness';

vi.mock('@/lib/rbac', async () => (await import('../../helpers/eblast-version-route-harness')).rbacMock());
vi.mock('@/lib/tenant-context', async () => (await import('../../helpers/eblast-version-route-harness')).tenantContextMock());
vi.mock('@/lib/logger', async () => (await import('../../helpers/eblast-version-route-harness')).loggerMock());
vi.mock('@/lib/member-context', async () => {
  const h = await import('../../helpers/eblast-version-route-harness');
  return { requireMemberContext: async () => h.memberCtx() };
});
vi.mock('@/lib/broadcast-approval-deps', async () =>
  (await import('../../helpers/eblast-version-route-harness')).approvalDepsMock(),
);
/**
 * The drainer's view of the barrel: the flag helper is `harness.flagOn`, and
 * the skip set is a COPY of the port's `F119_NOTIFICATION_TYPES` the positive
 * control can drop a value from.
 */
const drainer = vi.hoisted(() => ({ wheres: [] as unknown[], skipTypes: [] as string[] }));
vi.mock('@/modules/broadcasts', async () => {
  const h = await import('../../helpers/eblast-version-route-harness');
  const port = await import('@/modules/broadcasts/application/ports/eblast-notification-outbox-port');
  drainer.skipTypes.push(...port.F119_NOTIFICATION_TYPES);
  return {
    ...(await h.broadcastsBarrelMock()),
    isEblastMemberApprovalEnabled: () => h.harness.flagOn,
    F119_NOTIFICATION_TYPES: drainer.skipTypes,
  };
});
/**
 * `db` for the outbox-dispatch `GET`: the lock-less candidate SELECT
 * (`{ id }`) records its WHERE and finds nothing ready; the stuck-rows count
 * reads 0. No other query runs when nothing is ready.
 */
vi.mock('@/lib/db', () => {
  const select = (fields?: Record<string, unknown>) => {
    const query = {
      from: () => query,
      where: (cond: unknown) => {
        if (fields !== undefined && Object.keys(fields).join() === 'id') drainer.wheres.push(cond);
        return query;
      },
      limit: async () => [],
      then: (resolve: (rows: unknown) => unknown) => resolve([{ stuckCount: 0 }]),
    };
    return query;
  };
  return { db: { select }, runInTenant: vi.fn() };
});
// The route imports the invoicing barrel for its F4 arms; none runs here.
vi.mock('@/modules/invoicing', () => ({}));

const V0 = makeApprovalVersion({ id: 'aaaaaaaa-0000-4000-8000-000000000000', versionNo: 0, sentToMemberAt: new Date('2026-09-20T08:00:00Z') });
const V1_SENT = makeApprovalVersion({ versionNo: 1, sentToMemberAt: new Date('2026-09-21T08:00:00Z') });
const ID = makeApprovalBroadcast().broadcastId as string;

async function startOn(broadcast: Broadcast, flagOn: boolean, versions = [V0, V1_SENT]) {
  resetVersionHarness({ broadcasts: [broadcast], versions: broadcast.currentRound >= 1 ? versions : [] });
  harness.flagOn = flagOn;
  const { POST } = await importVersionRoute();
  return POST(postVersionRequest(ID), routeParams(ID));
}

describe.each([
  { flag: 'on', flagOn: true },
  { flag: 'off', flagOn: false },
])('FEATURE_EBLAST_MEMBER_APPROVAL $flag', ({ flagOn }) => {
  it(`POST …/[id]/version on a submitted broadcast → ${flagOn ? '201' : '404, nothing written, no probe audit'}`, async () => {
    const res = await startOn(makeApprovalBroadcast({ status: 'submitted' }), flagOn);
    if (flagOn) {
      expect(res.status).toBe(201);
      expect(harness.store.state.broadcasts.get(`test-tenant::${ID}`)!.status).toBe('in_design');
      return;
    }
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('broadcast_not_found');
    expect(harness.store.state.broadcasts.get(`test-tenant::${ID}`)!.status).toBe('submitted');
    expect(harness.store.versionsRepo.rows()).toHaveLength(0);
    // A dark feature is not a cross-tenant probe: nothing is audited.
    expect(harness.audit.events).toHaveLength(0);
  });

  it('POST …/[id]/version on changes_requested → 201 (re-entry after the member asked for changes is an exit-side write)', async () => {
    const res = await startOn(makeApprovalBroadcast({ status: 'changes_requested', currentRound: 1 }), flagOn);
    expect(res.status).toBe(201);
  });

  it.each(['member_approved', 'approved'] as const)(
    'POST …/[id]/version on %s with current_round >= 1 → 201',
    async (status) => {
      const res = await startOn(
        makeApprovalBroadcast({ status, currentRound: 1, approvedVersionId: V1_SENT.id }),
        flagOn,
      );
      expect(res.status).toBe(201);
    },
  );

  it.each(['member_approved', 'approved'] as const)(
    'POST …/[id]/version on %s with current_round = 0 → 409 round_zero',
    async (status) => {
      const res = await startOn(makeApprovalBroadcast({ status, currentRound: 0 }), flagOn);
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe('round_zero');
      expect(harness.store.versionsRepo.rows()).toHaveLength(0);
    },
  );

  it('a broadcast already in in_design can still be saved (PATCH …/version → 200)', async () => {
    const working = makeApprovalVersion({ id: 'aaaaaaaa-0000-4000-8000-000000000002', versionNo: 2, updatedAt: new Date('2026-09-24T08:30:00Z') });
    resetVersionHarness({
      broadcasts: [makeApprovalBroadcast({ status: 'in_design', currentRound: 1 })],
      versions: [V0, V1_SENT, working],
    });
    harness.flagOn = flagOn;
    const { PATCH } = await importVersionRoute();
    const res = await PATCH(
      patchVersionRequest(ID, {
        subject: 'Round two',
        bodyHtml: '<p>Round two</p>',
        bodySource: '{}',
        noteToMember: null,
        expectedUpdatedAt: working.updatedAt.toISOString(),
      }),
      routeParams(ID),
    );
    expect(res.status).toBe(200);
  });

  it('a broadcast already in in_design can still be SENT to the member (POST …/version/send → 200)', async () => {
    const working = makeApprovalVersion({ id: 'aaaaaaaa-0000-4000-8000-000000000002', versionNo: 2 });
    resetVersionHarness({
      broadcasts: [makeApprovalBroadcast({ status: 'in_design', currentRound: 1 })],
      versions: [V0, V1_SENT, working],
    });
    harness.flagOn = flagOn;
    const { POST } = await importSendRoute();
    const res = await POST(postSendRequest(ID), routeParams(ID));
    expect(res.status).toBe(200);
    expect(harness.store.state.broadcasts.get(`test-tenant::${ID}`)!).toMatchObject({ status: 'awaiting_member_approval', currentRound: 2 });
  });

  it('a broadcast already in awaiting_member_approval can still be DECIDED (POST …/decision → 200)', async () => {
    resetVersionHarness({
      broadcasts: [makeApprovalBroadcast({ status: 'awaiting_member_approval', currentRound: 1 })],
      versions: [V0, V1_SENT],
    });
    harness.flagOn = flagOn;
    const { POST } = await importDecisionRoute();
    const res = await POST(postDecisionRequest(ID, { versionId: V1_SENT.id, decision: 'approved' }), routeParams(ID));
    expect(res.status).toBe(200);
    expect(harness.store.state.broadcasts.get(`test-tenant::${ID}`)!).toMatchObject({ status: 'member_approved', approvedVersionId: V1_SENT.id });
  });

  it('a broadcast already in member_approved can still be SCHEDULED (POST …/schedule → 200, promoted)', async () => {
    resetVersionHarness({
      broadcasts: [makeApprovalBroadcast({ status: 'member_approved', currentRound: 1, approvedVersionId: V1_SENT.id })],
      versions: [V0, V1_SENT],
    });
    harness.flagOn = flagOn;
    const { POST } = await importScheduleRoute();
    const res = await POST(postScheduleRequest(ID, { mode: 'send_now' }), routeParams(ID));
    expect(res.status).toBe(200);
    expect(harness.store.state.broadcasts.get(`test-tenant::${ID}`)!).toMatchObject({ status: 'approved', subject: V1_SENT.subject });
  });
});

/**
 * "Every existing E-Blast acceptance test passes unchanged with the flag off"
 * — stated as exactly what this file can prove, and no more:
 *
 *   1. In CI the whole existing suite IS the flag-off run: the env default is
 *      `false` (pinned by `env-eblast-member-approval.test.ts`), CI has no
 *      `.env.local`, and `tests/setup.ts` does not force the variable on
 *      (checked here in both the `FLAG=` and `process.env['FLAG'] =` forms).
 *   2. Nothing those tests exercise can observe the flag: the helper is read
 *      only by the composition root of the `…/[id]/version` routes and by the
 *      outbox drainer's selection (T152a); no pre-F119 test reaches either with
 *      an F119 row. A new reader must be added to the allow-list below on
 *      purpose — T063's staff detail page is one, and it reads the flag for
 *      an AFFORDANCE only (see its entry).
 *
 * It does NOT re-run the suite under both flag states.
 */
describe('the existing E-Blast suite runs flag-off, and nothing it exercises reads the flag', () => {
  const ROOT = join(__dirname, '..', '..', '..');
  const toPosix = (p: string) => p.split(sep).join('/');

  function listSources(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...listSources(full));
      else if (/\.(ts|tsx)$/.test(name)) out.push(full);
    }
    return out;
  }

  /** Files whose CODE (comments stripped) names the flag helper or the env key. */
  function readersOf(pattern: RegExp): string[] {
    return listSources(join(ROOT, 'src'))
      .filter((file) => {
        const code = readFileSync(file, 'utf8')
          .split(/\r?\n/)
          .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
          .join('\n');
        return pattern.test(code);
      })
      .map((file) => toPosix(relative(ROOT, file)))
      .sort();
  }

  // The zod default (`false`) is pinned by tests/unit/lib/env-eblast-member-approval.test.ts
  // under a stubbed env. It is NOT re-asserted here against the live env:
  // tests/setup.ts loads `.env.local`, and a developer who sets the flag to walk
  // the UAT script (T153) must not turn this suite red (setup.ts:76-83).
  it('tests/setup.ts does not force the flag on (both assignment forms)', () => {
    const setup = readFileSync(join(ROOT, 'tests', 'setup.ts'), 'utf8');
    expect(setup).not.toMatch(/FEATURE_EBLAST_MEMBER_APPROVAL\s*[=:]/);
    expect(setup).not.toMatch(/process\.env\[\s*['"]FEATURE_EBLAST_MEMBER_APPROVAL['"]\s*\]\s*=/);
  });

  it('the flag is read only by its definition, the barrel re-export, the version routes\' composition root, the outbox drainer and the staff detail page (affordance only)', () => {
    const helperReaders = readersOf(/\bisEblastMemberApprovalEnabled\b/);
    // Positive control: a scan that found nothing would pass the next line vacuously.
    expect(helperReaders).toContain('src/modules/broadcasts/infrastructure/feature-flags.ts');
    expect(helperReaders).toEqual([
      // T063 / T152 — the staff detail page hides "Start formatted version" on
      // a `submitted` E-Blast while the flag is off. A UI affordance, never the
      // gate (the use case refuses the `submitted → in_design` edge itself);
      // on `submitted` the only remaining path is approve-as-submitted, which
      // the page renders in both flag states (FR-007, FR-034).
      'src/app/(staff)/admin/broadcasts/[id]/page.tsx',
      // T152a — the drainer's SELECTION skips the five eblast_* types while the
      // flag is off. No pre-F119 test reaches that branch with an F119 row: the
      // F7 / F114 dispatch suites seed none of those types, so their rows are
      // selected in either flag state.
      'src/app/api/cron/outbox-dispatch/route.ts',
      'src/lib/broadcast-approval-deps.ts',
      // T132 — the staff nav's E-Blast waiting count stays hidden while the
      // flag is off AND no row is in an approval-round stage (R18). Display
      // only: it gates no write and no email.
      'src/lib/eblast-waiting-count.ts',
      'src/modules/broadcasts/index.ts',
      'src/modules/broadcasts/infrastructure/feature-flags.ts',
    ]);
    expect(readersOf(/\beblastMemberApproval\b/)).toEqual([
      'src/lib/env.ts',
      'src/modules/broadcasts/infrastructure/feature-flags.ts',
    ]);
  });
});

// ---------------------------------------------------------------------------
// T149a (the RED for T152a) — with the flag off, no F119 hand-off is delivered
// ---------------------------------------------------------------------------

/** The `notification_type` values the candidate SELECT's WHERE excludes, read from the rendered SQL. */
function excludedTypes(where: unknown): Set<string> {
  const { sql, params } = new PgDialect().sqlToQuery(where as SQL);
  const out = new Set<string>();
  for (const m of sql.matchAll(/"notification_type" <> \$(\d+)/g)) out.add(String(params[Number(m[1]) - 1]));
  for (const m of sql.matchAll(/"notification_type" not in \(([^)]*)\)/g)) {
    for (const p of m[1]!.matchAll(/\$(\d+)/g)) out.add(String(params[Number(p[1]) - 1]));
  }
  return out;
}

describe('T149a — the outbox drainer skips the five eblast_* notification types while the flag is off', () => {
  /** Enumerated from the ENUM, not from the skip set — a sixth value would have to be added here on purpose. */
  const EBLAST_TYPES = notificationTypeEnum.enumValues.filter((v) => v.startsWith('eblast_'));

  async function tick(flagOn: boolean): Promise<Set<string>> {
    drainer.wheres.length = 0;
    harness.flagOn = flagOn;
    vi.stubEnv('CRON_SECRET', 'cron-secret-flag-matrix-0123456789');
    const { GET } = await import('@/app/api/cron/outbox-dispatch/route');
    const res = await GET(
      new NextRequest('http://localhost/api/cron/outbox-dispatch', {
        headers: { authorization: 'Bearer cron-secret-flag-matrix-0123456789' },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, dispatched: 0 });
    expect(drainer.wheres).toHaveLength(1);
    return excludedTypes(drainer.wheres[0]);
  }

  it('flag off: all five are excluded from the candidate SELECT — never selected, so never sent, never attempted, never on the no_template_handler ladder', async () => {
    expect(EBLAST_TYPES).toHaveLength(5); // positive control on the enumeration
    const excluded = await tick(false);
    expect(EBLAST_TYPES.filter((t) => !excluded.has(t))).toEqual([]);
  });

  it('flag on: none of the five is excluded — the waiting rows drain on the first tick after the flip', async () => {
    const excluded = await tick(true);
    expect(EBLAST_TYPES.filter((t) => excluded.has(t))).toEqual([]);
  });

  it('positive control: a type dropped from the skip set is reported (the check reads the SQL the route built)', async () => {
    const dropped = drainer.skipTypes.pop()!;
    try {
      const excluded = await tick(false);
      expect(EBLAST_TYPES.filter((t) => !excluded.has(t))).toEqual([dropped]);
    } finally {
      drainer.skipTypes.push(dropped);
    }
  });

  /**
   * T129 — the enqueue half. The REAL `submitBroadcast` runs with the flag OFF
   * (`harness.flagOn = false` is what the barrel's `isEblastMemberApprovalEnabled`
   * answers here) and still writes one `eblast_submitted_marketing` row per
   * roster recipient: nothing on the submit path reads the flag (the reader
   * allow-list above pins that), so the row waits for the drainer's flip. The
   * ports are the minimum a submit touches; an unexpected call throws and the
   * submit would come back `submit.server_error`, failing the first assertion.
   */
  it('with the flag off, a SUBMIT writes its eblast_submitted_marketing outbox row — one per roster recipient, pending the flip (owner T129)', async () => {
    harness.flagOn = false;
    const { submitBroadcast } = await import('@/modules/broadcasts/application/use-cases/submit-broadcast');
    const { dompurifySanitizer } = await import('@/modules/broadcasts/infrastructure/sanitizer/dompurify-sanitizer');
    const { rfc5321EmailValidator } = await import('@/modules/broadcasts/infrastructure/email-validator/rfc5321-email-validator');
    const { unsafeBrandEmailLower } = await import('@/modules/broadcasts/domain/value-objects/email-lower');
    const { asTenantContext } = await import('@/modules/tenants');
    const { ok } = await import('@/lib/result');
    const enqueued: Array<{ type: string; toEmail: string }> = [];
    const deps = {
      tenant: asTenantContext('test-tenant'),
      broadcastsRepo: {
        withTx: async <T,>(fn: (tx: unknown) => Promise<T>) => fn('submit-tx'),
        countForMemberQuota: async () => ({ submittedOrApproved: 0, sent: 0 }),
        insertDraft: async (_tx: unknown, input: Record<string, unknown>) => ({ ...makeApprovalBroadcast(), ...input, status: 'draft' }),
        applyTransition: async (_tx: unknown, _t: unknown, broadcastId: string, status: string) => ({ ...makeApprovalBroadcast(), broadcastId, status }),
      },
      sanitizer: dompurifySanitizer,
      membersBridge: {
        getMembersHaltedInTenant: async () => [],
        getMemberPrimaryContact: async () => unsafeBrandEmailLower('owner@acme.test'),
        getMembersBySegment: async () => [
          { memberId: 'm-2', displayName: 'Recipient Co', primaryContactEmail: unsafeBrandEmailLower('r@example.com'), tierCode: null, broadcastsHaltedUntilAdminReview: false },
        ],
        filterMarketingOptedOut: async () => new Set(),
      },
      membershipAccess: { getMembershipAccess: async () => ok({ access: 'full', reason: 'in_good_standing' }) },
      plansBridge: { getPlanForMember: async () => ok({ planId: 'p', planCode: 'corporate', eblastPerYear: 6 }) },
      emailValidator: rfc5321EmailValidator,
      eventAttendees: { getLastNinetyDayAttendees: async () => [], lookupAttendeeEmailInTenant: async () => null },
      marketingUnsubscribes: { lookupBatch: async () => new Set() },
      audienceMode: 'primary_only' as const,
      audienceCeiling: 5000,
      rateLimiter: { checkLimit: async () => ok(true as const) },
      audit: { emit: async () => undefined, emitTyped: async () => undefined },
      clock: { now: () => new Date('2026-09-24T09:00:00Z') },
      marketingDirectory: {
        listRecipients: async () => [
          { userId: 'mk-1', email: 'marketing-1@swecham.test', locale: 'en' as const },
          { userId: 'mk-2', email: 'marketing-2@swecham.test', locale: 'en' as const },
        ],
      },
      eblastOutbox: {
        enqueueInTx: async (_tx: unknown, _t: unknown, r: { type: string; toEmail: string }) => {
          enqueued.push({ type: r.type, toEmail: r.toEmail });
        },
      },
    } as unknown as Parameters<typeof submitBroadcast>[0];
    const result = await submitBroadcast(deps, {
      memberId: 'm-1',
      submittedByUserId: 'u-1',
      actorRole: 'member_self_service',
      tenantDisplayName: 'Test Chamber',
      memberDisplayName: 'Acme Co',
      subject: 'Autumn mixer',
      bodySource: 'plain',
      bodyHtml: '<p>Join us</p>',
      segment: { kind: 'all_members' },
      scheduledFor: null,
      requestId: 'req-flag-off',
    });
    expect(result.ok ? 'submitted' : result.error).toBe('submitted');
    expect(enqueued).toEqual([
      { type: 'eblast_submitted_marketing', toEmail: 'marketing-1@swecham.test' },
      { type: 'eblast_submitted_marketing', toEmail: 'marketing-2@swecham.test' },
    ]);
  });
});
