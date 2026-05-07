/**
 * K16-1 (R14-S6) — `instrumentation.ts:register()` wiring smoke test.
 *
 * Closes R14-S6 deferred from K15: the K14-1 wiring of
 * `assertVercelDeploymentForTrustedXff()` after `registerOTel()` was
 * verified by code inspection + 6 unit tests pinning the function's
 * own behaviour, but no test pinned that `register()` ACTUALLY calls
 * it. The R13-W1 finding (triple-confirmed by 3 of 6 R13 agents)
 * was that K13-7 exported the function without wiring; only the
 * follow-up commit `6282e039` shipped the actual call. This test
 * makes the wiring CI-enforceable so a future refactor that drops
 * the call cannot slip past review.
 *
 * Mocks both deps (`@vercel/otel` + `@/lib/client-ip`) so the test
 * stays unit-scoped — neither real OTel SDK initialisation nor real
 * `process.env` inspection runs during the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registerOTelMock = vi.hoisted(() => vi.fn());
vi.mock('@vercel/otel', () => ({
  registerOTel: registerOTelMock,
}));

const assertVercelDeploymentForTrustedXffMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/client-ip', () => ({
  assertVercelDeploymentForTrustedXff:
    assertVercelDeploymentForTrustedXffMock,
}));

// `instrumentation.ts` is the Next.js convention boot-loader at the
// repo root, NOT under `src/`, so the `@/` alias does not resolve it.
// Use the relative path from this test file's location.
import { register } from '../../instrumentation';

describe('instrumentation.register() — boot-time wiring (K16-1 R14-S6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls registerOTel with the canonical serviceName', () => {
    register();
    expect(registerOTelMock).toHaveBeenCalledTimes(1);
    expect(registerOTelMock.mock.calls[0]![0]).toMatchObject({
      serviceName: 'swecham-membership',
    });
  });

  it('K14-1 (R13-W1): calls assertVercelDeploymentForTrustedXff exactly once', () => {
    // The R13-W1 finding was triple-confirmed: the function was
    // exported but never called. K14-1 + the follow-up commit shipped
    // the wiring; this test pins it so a future refactor that drops
    // the call would FAIL CI rather than silently re-opening the
    // SEC-R12-1 XFF spoofing risk on off-Vercel deployments.
    register();
    expect(assertVercelDeploymentForTrustedXffMock).toHaveBeenCalledTimes(1);
  });

  it('calls registerOTel BEFORE assertVercelDeploymentForTrustedXff', () => {
    // OTel must be set up first so any tracer/meter calls inside the
    // assertion (currently none, but a future expansion might add
    // OTel emissions) have an SDK to bind to.
    register();
    const otelOrder = registerOTelMock.mock.invocationCallOrder[0]!;
    const assertOrder =
      assertVercelDeploymentForTrustedXffMock.mock.invocationCallOrder[0]!;
    expect(otelOrder).toBeLessThan(assertOrder);
  });

  it('does NOT throw when the assertion warns (off-Vercel + no opt-out)', () => {
    // The assertion fires `console.warn` in the off-Vercel + no-opt-out
    // case but never throws. register() must not propagate any
    // assertion behaviour as an exception — the boot path has no
    // try/catch and a throw would block the Next.js runtime.
    assertVercelDeploymentForTrustedXffMock.mockImplementation(() => {
      // simulate the assertion's typical no-throw side-effect
    });
    expect(() => register()).not.toThrow();
  });
});
