/**
 * T023 — F7 Kill-switch foundational integration test.
 *
 * Wave 6 GREEN. The kill-switch helper (`src/modules/broadcasts/
 * infrastructure/kill-switch.ts`) is the single source of truth for
 * the `FEATURE_F7_BROADCASTS` flag. Production routes call
 * `assertF7Enabled()` at the entry point + map the throw to a 503
 * `feature_disabled` envelope.
 *
 * Mid-flight visibility (Spec § Edge Cases L341 + Q14): admin routes
 * operating on EXISTING broadcasts MUST keep `isF7Enabled()` for
 * conditional UI but MUST NOT throw — they let the queue close even
 * with the kill-switch off.
 *
 * This test verifies the helper's behaviour by mutating `env.features
 * .f7Broadcasts` at runtime via `vi.mock`. The route layer's 503 mapping
 * is verified at the contract test level (`tests/contract/broadcasts/`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const envMock = { features: { f7Broadcasts: true } };

vi.mock('@/lib/env', () => ({
  env: envMock,
}));

let assertF7Enabled: () => void;
let isF7Enabled: () => boolean;
let F7DisabledError: new (msg?: string) => Error;

beforeEach(async () => {
  vi.resetModules();
  // Re-import after each reset so the module-level cache reflects the
  // currently-mocked env.
  const mod = await import(
    '@/modules/broadcasts/infrastructure/kill-switch'
  );
  assertF7Enabled = mod.assertF7Enabled;
  isF7Enabled = mod.isF7Enabled;
  F7DisabledError = mod.F7DisabledError;
});
afterEach(() => {
  envMock.features.f7Broadcasts = true;
});

describe('F7 kill-switch (T023)', () => {
  it('FEATURE_F7_BROADCASTS=true: assertF7Enabled() does NOT throw', () => {
    envMock.features.f7Broadcasts = true;
    expect(() => assertF7Enabled()).not.toThrow();
  });

  it('FEATURE_F7_BROADCASTS=false: assertF7Enabled() throws F7DisabledError', () => {
    envMock.features.f7Broadcasts = false;
    expect(() => assertF7Enabled()).toThrow(F7DisabledError);
  });

  it('F7DisabledError carries kind="feature_disabled"', () => {
    envMock.features.f7Broadcasts = false;
    try {
      assertF7Enabled();
      throw new Error('did not throw');
    } catch (e) {
      expect(e).toBeInstanceOf(F7DisabledError);
      expect((e as { kind: string }).kind).toBe('feature_disabled');
    }
  });

  it('isF7Enabled() returns true when flag is on', () => {
    envMock.features.f7Broadcasts = true;
    expect(isF7Enabled()).toBe(true);
  });

  it('isF7Enabled() returns false when flag is off (no throw)', () => {
    envMock.features.f7Broadcasts = false;
    expect(isF7Enabled()).toBe(false);
  });

  it('mid-flight: isF7Enabled() may return false WITHOUT triggering throw on admin routes', () => {
    // The contract: admin routes use isF7Enabled() as a soft gate
    // (returns boolean), so they survive a flag flip while in-flight
    // broadcasts are processed. Verified by the absence of `throw`.
    envMock.features.f7Broadcasts = false;
    let threw = false;
    try {
      const enabled = isF7Enabled();
      expect(enabled).toBe(false);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  it('flag re-enabled mid-session: subsequent assertF7Enabled() resumes normal flow', () => {
    envMock.features.f7Broadcasts = false;
    expect(() => assertF7Enabled()).toThrow(F7DisabledError);
    envMock.features.f7Broadcasts = true;
    expect(() => assertF7Enabled()).not.toThrow();
  });

  it('flag toggled false → true → false: each call reads current state', () => {
    envMock.features.f7Broadcasts = false;
    expect(() => assertF7Enabled()).toThrow();
    envMock.features.f7Broadcasts = true;
    expect(() => assertF7Enabled()).not.toThrow();
    envMock.features.f7Broadcasts = false;
    expect(() => assertF7Enabled()).toThrow();
  });

  it('F7DisabledError default message is informative', () => {
    envMock.features.f7Broadcasts = false;
    try {
      assertF7Enabled();
    } catch (e) {
      expect((e as Error).message.toLowerCase()).toMatch(/disabled|f7/);
    }
  });

  it('F7DisabledError accepts custom message', () => {
    const e = new F7DisabledError('custom reason');
    expect(e.message).toBe('custom reason');
  });

  it('F7DisabledError instanceof Error (catchable in standard catch)', () => {
    envMock.features.f7Broadcasts = false;
    try {
      assertF7Enabled();
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
    }
  });
});
