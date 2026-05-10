/**
 * F8 Phase 5 Wave A.5 · T120 spec — `verifyRenewalLinkToken` use-case.
 *
 * Target: 100% branch coverage (security-critical path per Constitution
 * coverage table — sign-in equivalent surface). Covers:
 *   - Input validation (invalid_input)
 *   - 5 verifier-error paths → 4 distinct audit reasons
 *   - Cycle-existence + member-tenant-ownership (collapsed step 7)
 *   - CHK033 race-window: cycle already completed (idempotent)
 *   - Replay detection (atomic mark-consumed)
 *   - Happy path (renewal_self_service_initiated audit)
 *   - Audit emit failure does NOT mask the verify result (fire-and-forget
 *     contract per Wave I2 / dispatch precedent)
 */
import { describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import { verifyRenewalLinkToken } from '@/modules/renewals/application/use-cases/verify-renewal-link-token';
import type { VerifyRenewalLinkTokenDeps } from '@/modules/renewals/application/use-cases/verify-renewal-link-token';
import type { RenewalLinkTokenVerifier } from '@/modules/renewals/application/ports/renewal-link-token-verifier';
import type {
  ConsumedLinkTokensRepo,
  MarkConsumedResult,
} from '@/modules/renewals/application/ports/consumed-link-tokens-repo';
import { buildCycle as buildCycleShared } from '../../_helpers/build-cycle';
import { asCycleId, type RenewalCycle } from '@/modules/renewals/domain/renewal-cycle';

const TENANT_ID = 'swecham';
const MEMBER_ID = '00000000-0000-0000-0000-000000000m01';
const CYCLE_UUID = '00000000-0000-0000-0000-0000000c1d00';
const NOW = new Date('2026-05-07T12:00:00Z');

function makePayload(overrides: Partial<{ tid: string; mid: string; cid: string }> = {}) {
  return {
    v: 1 as const,
    tid: overrides.tid ?? TENANT_ID,
    mid: overrides.mid ?? MEMBER_ID,
    cid: overrides.cid ?? CYCLE_UUID,
    iat: Math.floor(NOW.getTime() / 1000) - 3600,
    exp: Math.floor(NOW.getTime() / 1000) + 86400,
  };
}

function buildCycle(
  overrides: Partial<RenewalCycle> = {},
): RenewalCycle {
  return buildCycleShared({
    tenantId: TENANT_ID,
    cycleId: asCycleId(CYCLE_UUID),
    memberId: MEMBER_ID,
    ...overrides,
  });
}

function fakeDeps(opts: {
  verifyResult: ReturnType<RenewalLinkTokenVerifier['verify']>;
  cycle?: RenewalCycle | null;
  markConsumedResult?: MarkConsumedResult;
  emitImpl?: () => Promise<void>;
}): {
  deps: VerifyRenewalLinkTokenDeps;
  verifyMock: ReturnType<typeof vi.fn>;
  findByIdMock: ReturnType<typeof vi.fn>;
  markConsumedMock: ReturnType<typeof vi.fn>;
  emitMock: ReturnType<typeof vi.fn>;
} {
  const verifyMock = vi.fn(() => opts.verifyResult);
  const findByIdMock = vi.fn(async () => opts.cycle ?? null);
  const markConsumedMock = vi.fn(
    async (): Promise<MarkConsumedResult> =>
      opts.markConsumedResult ?? { status: 'fresh', consumedAt: NOW },
  );
  const emitMock = vi.fn(opts.emitImpl ?? (async () => {}));
  const deps: VerifyRenewalLinkTokenDeps = {
    tenant: { slug: TENANT_ID } as VerifyRenewalLinkTokenDeps['tenant'],
    tokenVerifier: { verify: verifyMock as unknown as RenewalLinkTokenVerifier['verify'] },
    cyclesRepo: {
      findById: findByIdMock,
    } as unknown as VerifyRenewalLinkTokenDeps['cyclesRepo'],
    consumedLinkTokensRepo: {
      markConsumed: markConsumedMock,
    } as unknown as ConsumedLinkTokensRepo,
    auditEmitter: {
      emit: emitMock,
      emitInTx: vi.fn(async () => {}),
    } as unknown as VerifyRenewalLinkTokenDeps['auditEmitter'],
  };
  return { deps, verifyMock, findByIdMock, markConsumedMock, emitMock };
}

const baseInput = {
  rawToken: 'v1.payload.mac',
  expectedTenantId: TENANT_ID,
  now: NOW,
  requestId: 'req-1',
  correlationId: 'corr-1',
};

const verifiedToken = {
  payload: makePayload(),
  tokenSha256: new Uint8Array(32),
  verifiedWith: 'primary' as const,
};

describe('verifyRenewalLinkToken (T120) — input validation', () => {
  it('rejects with invalid_input when rawToken is empty', async () => {
    const { deps } = fakeDeps({ verifyResult: ok(verifiedToken) });
    const r = await verifyRenewalLinkToken(deps, { ...baseInput, rawToken: '' });
    expect(r.ok).toBe(false);
    // PR #24 deep-review fix — `invalid_input` is now its own discriminated
    // arm, separate from the security-rejection `invalid_token` paths.
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
  });
});

describe('verifyRenewalLinkToken (T120) — 5 verifier-error paths', () => {
  it.each([
    ['malformed_token', 'malformed_token'],
    ['signature_mismatch', 'mac_mismatch'],
    ['wrong_version', 'malformed_token'],
    ['expired', 'expired'],
    ['tenant_mismatch', 'cross_tenant'],
  ] as const)(
    'maps verifier %s → reason %s + emits renewal_token_invalid audit',
    async (verifierKind, expectedReason) => {
      const verifyError =
        verifierKind === 'wrong_version'
          ? { kind: verifierKind, raw: 99 }
          : verifierKind === 'tenant_mismatch'
            ? {
                kind: verifierKind,
                expectedTenantId: TENANT_ID,
                tokenTenantId: 'other',
              }
            : verifierKind === 'expired'
              ? {
                  kind: verifierKind,
                  expSec: 0,
                  nowSec: Math.floor(NOW.getTime() / 1000),
                }
              : { kind: verifierKind };
      const { deps, emitMock } = fakeDeps({
        verifyResult: err(verifyError as never),
      });
      const r = await verifyRenewalLinkToken(deps, baseInput);
      expect(r.ok).toBe(false);
      if (!r.ok && r.error.kind === 'invalid_token') expect(r.error.reason).toBe(expectedReason);
      expect(emitMock).toHaveBeenCalledTimes(1);
      expect(emitMock.mock.calls[0]![0]).toEqual({
        type: 'renewal_token_invalid',
        payload: { reason: expectedReason },
      });
    },
  );
});

describe('verifyRenewalLinkToken (T120) — step 7 member-tenant ownership', () => {
  it('rejects with member_not_found_in_tenant when cycle is null (RLS-hidden or absent)', async () => {
    const { deps, emitMock } = fakeDeps({
      verifyResult: ok(verifiedToken),
      cycle: null,
    });
    const r = await verifyRenewalLinkToken(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'invalid_token') expect(r.error.reason).toBe('member_not_found_in_tenant');
    expect(emitMock.mock.calls[0]![0]).toMatchObject({
      type: 'renewal_token_invalid',
      payload: { reason: 'member_not_found_in_tenant' },
    });
  });

  it('rejects with member_not_found_in_tenant when cycle.memberId mismatches token.mid', async () => {
    const cycle = buildCycle({ memberId: 'different-member' });
    const { deps } = fakeDeps({ verifyResult: ok(verifiedToken), cycle });
    const r = await verifyRenewalLinkToken(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'invalid_token') expect(r.error.reason).toBe('member_not_found_in_tenant');
  });

  it('rejects with member_not_found_in_tenant when payload.cid is not a valid UUID', async () => {
    const verified = {
      ...verifiedToken,
      payload: makePayload({ cid: 'not-a-uuid' }),
    };
    const { deps, findByIdMock } = fakeDeps({ verifyResult: ok(verified) });
    const r = await verifyRenewalLinkToken(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'invalid_token') expect(r.error.reason).toBe('member_not_found_in_tenant');
    // Cycle lookup MUST NOT run — UUID parse failed first
    expect(findByIdMock).not.toHaveBeenCalled();
  });
});

describe('verifyRenewalLinkToken (T120) — CHK033 race window', () => {
  it('returns cycle_already_completed (idempotent) and does NOT mark token consumed', async () => {
    const cycle = buildCycle({ status: 'completed' });
    const { deps, emitMock, markConsumedMock } = fakeDeps({
      verifyResult: ok(verifiedToken),
      cycle,
    });
    const r = await verifyRenewalLinkToken(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('cycle_already_completed');
      expect(r.value.memberId).toBe(MEMBER_ID);
    }
    expect(markConsumedMock).not.toHaveBeenCalled();
    expect(emitMock.mock.calls[0]![0]).toMatchObject({
      type: 'renewal_token_clicked_on_completed_cycle',
    });
  });
});

describe('verifyRenewalLinkToken (T120) — replay detection', () => {
  it('rejects with replayed reason when markConsumed returns replay', async () => {
    const cycle = buildCycle({ status: 'awaiting_payment' });
    const { deps, emitMock } = fakeDeps({
      verifyResult: ok(verifiedToken),
      cycle,
      markConsumedResult: { status: 'replay', firstConsumedAt: NOW },
    });
    const r = await verifyRenewalLinkToken(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'invalid_token') expect(r.error.reason).toBe('replayed');
    expect(emitMock.mock.calls[0]![0]).toMatchObject({
      type: 'renewal_token_invalid',
      payload: { reason: 'replayed' },
    });
  });
});

describe('verifyRenewalLinkToken (T120) — happy path', () => {
  it('returns success + emits renewal_self_service_initiated', async () => {
    const cycle = buildCycle({ status: 'awaiting_payment' });
    const { deps, emitMock, markConsumedMock } = fakeDeps({
      verifyResult: ok(verifiedToken),
      cycle,
    });
    const r = await verifyRenewalLinkToken(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('success');
      expect(r.value.memberId).toBe(MEMBER_ID);
      expect(r.value.cycleId).toBe(CYCLE_UUID);
      expect(r.value.verifiedWith).toBe('primary');
    }
    expect(markConsumedMock).toHaveBeenCalledTimes(1);
    expect(emitMock.mock.calls[0]![0]).toMatchObject({
      type: 'renewal_self_service_initiated',
    });
  });
});

describe('verifyRenewalLinkToken (T120) — fire-and-forget audit', () => {
  it('returns ok even if success-path audit emit throws', async () => {
    const cycle = buildCycle({ status: 'awaiting_payment' });
    const { deps } = fakeDeps({
      verifyResult: ok(verifiedToken),
      cycle,
      emitImpl: async () => {
        throw new Error('audit_log: insert failed');
      },
    });
    const r = await verifyRenewalLinkToken(deps, baseInput);
    expect(r.ok).toBe(true);
  });

  it('returns err even if reject-path audit emit throws', async () => {
    const { deps } = fakeDeps({
      verifyResult: err({ kind: 'expired', expSec: 0, nowSec: 1 } as never),
      emitImpl: async () => {
        throw new Error('audit_log: insert failed');
      },
    });
    const r = await verifyRenewalLinkToken(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'invalid_token') expect(r.error.reason).toBe('expired');
  });

  it('returns ok even if completed-cycle audit emit throws (idempotent path)', async () => {
    const cycle = buildCycle({ status: 'completed' });
    const { deps } = fakeDeps({
      verifyResult: ok(verifiedToken),
      cycle,
      emitImpl: async () => {
        throw new Error('audit_log: insert failed');
      },
    });
    const r = await verifyRenewalLinkToken(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.kind).toBe('cycle_already_completed');
  });
});
