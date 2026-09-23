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
 * `isEblastMemberApprovalEnabled()` read. Arms that need later routes — "sent,
 * decided and scheduled" with the flag off (T059/T078/T060) and the drainer
 * skip (T149a/T152a) — join this file with those routes.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Broadcast } from '@/modules/broadcasts/domain/broadcast';
import { makeApprovalBroadcast, makeApprovalVersion } from '../../helpers/eblast-approval-fakes';
import {
  harness,
  importVersionRoute,
  patchVersionRequest,
  postVersionRequest,
  resetVersionHarness,
  routeParams,
} from '../../helpers/eblast-version-route-harness';

vi.mock('@/lib/rbac', async () => (await import('../../helpers/eblast-version-route-harness')).rbacMock());
vi.mock('@/lib/tenant-context', async () => (await import('../../helpers/eblast-version-route-harness')).tenantContextMock());
vi.mock('@/lib/logger', async () => (await import('../../helpers/eblast-version-route-harness')).loggerMock());
vi.mock('@/lib/broadcast-approval-deps', async () =>
  (await import('../../helpers/eblast-version-route-harness')).approvalDepsMock(),
);
vi.mock('@/modules/broadcasts', async () =>
  (await import('../../helpers/eblast-version-route-harness')).broadcastsBarrelMock(),
);

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
 *      only by the composition root of the `…/[id]/version` routes, which no
 *      pre-F119 test reaches. A new reader must be added to the allow-list
 *      below on purpose (T152a's outbox drainer, T063's detail page).
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

  it('the flag is read only by its definition, the barrel re-export and the version routes\' composition root', () => {
    const helperReaders = readersOf(/\bisEblastMemberApprovalEnabled\b/);
    // Positive control: a scan that found nothing would pass the next line vacuously.
    expect(helperReaders).toContain('src/modules/broadcasts/infrastructure/feature-flags.ts');
    expect(helperReaders).toEqual([
      'src/lib/broadcast-approval-deps.ts',
      'src/modules/broadcasts/index.ts',
      'src/modules/broadcasts/infrastructure/feature-flags.ts',
    ]);
    expect(readersOf(/\beblastMemberApproval\b/)).toEqual([
      'src/lib/env.ts',
      'src/modules/broadcasts/infrastructure/feature-flags.ts',
    ]);
  });
});
