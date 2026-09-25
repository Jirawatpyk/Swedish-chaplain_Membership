/**
 * F119 T152 — the `FEATURE_EBLAST_MEMBER_APPROVAL` gate AT ITS WIRING.
 *
 * The flag gates one edge (`submitted → in_design`), and the use case reads it
 * as a boolean the composition root hands it: `makeStartFormattedVersionDeps`
 * in `src/lib/broadcast-approval-deps.ts` builds
 * `memberApprovalEnabled: isEblastMemberApprovalEnabled()`. Every other test
 * INJECTS that boolean (the flag matrix through `harness.flagOn`, the live
 * suites through `{ ...deps, memberApprovalEnabled: true }`), so a composition
 * root that hard-coded `true`, negated the read, or read the wrong helper
 * would pass all of them. This one builds the deps from the REAL env, off and
 * then on, and reads the field.
 *
 * Both layers are stubbed for "on": the helper is F7 master AND this flag.
 * Env pattern: `env-eblast-member-approval.test.ts` (stub, reset, fresh import).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const TENANT = 'test-swecham';

async function depsWith(flags: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(flags)) vi.stubEnv(k, v);
  vi.resetModules();
  const mod = await import('@/lib/broadcast-approval-deps');
  return mod.makeStartFormattedVersionDeps(TENANT);
}

describe('makeStartFormattedVersionDeps — memberApprovalEnabled is read from the env (T152 wiring)', () => {
  // The composition root pulls in the broadcasts, auth and members barrels:
  // pay the cold transform once here, not inside the first case's budget.
  beforeAll(async () => {
    await import('@/lib/broadcast-approval-deps');
  }, 120_000);

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is false when FEATURE_EBLAST_MEMBER_APPROVAL is off (the dark-ship default), even with F7 on', async () => {
    const deps = await depsWith({ FEATURE_F7_BROADCASTS: 'true', FEATURE_EBLAST_MEMBER_APPROVAL: 'false' });
    expect(deps.memberApprovalEnabled).toBe(false);
  });

  it('is true when F7 and FEATURE_EBLAST_MEMBER_APPROVAL are both on', async () => {
    const deps = await depsWith({ FEATURE_F7_BROADCASTS: 'true', FEATURE_EBLAST_MEMBER_APPROVAL: 'true' });
    expect(deps.memberApprovalEnabled).toBe(true);
  });

  it('is false when the F7 master kill-switch is off, whatever the approval flag says', async () => {
    const deps = await depsWith({ FEATURE_F7_BROADCASTS: 'false', FEATURE_EBLAST_MEMBER_APPROVAL: 'true' });
    expect(deps.memberApprovalEnabled).toBe(false);
  });
});
