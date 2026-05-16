/**
 * R2-I-8 close (R3 — pr-test-analyzer) — Symbol-brand collision
 * resistance for `CancellationSkipMarker`.
 *
 * The marker is thrown inside the SAVEPOINT callback (import-csv.ts:761)
 * and caught at line 813 via `isCancellationSkip(e)`. Constitution
 * Principle II + R1 CR-10 documentation claim the guard defends
 * against:
 *
 *   (a) Plain Error / unrelated subclass — must NOT pass.
 *   (b) Third-party / cross-realm shadow-class with the same NAME
 *       but different identity — must NOT pass.
 *   (c) Legitimate CancellationSkipMarker — MUST pass.
 *
 * Without this test, a regression that "simplifies" the guard to
 * `e instanceof Error && e.message.includes('Cancellation skip marker')`
 * (or drops the brand-equality check entirely) would slip through CI
 * — the integration test only exercises the happy path (a) + (c).
 */
import { describe, expect, it } from 'vitest';
import { _internals } from '@/modules/events/application/use-cases/import-csv';

const { CancellationSkipMarker, isCancellationSkip, hashAttendeeEmail } =
  _internals;

const FAKE_HASH = hashAttendeeEmail('cancel.test@example.com');

describe('CancellationSkipMarker — Symbol-brand collision resistance', () => {
  it('isCancellationSkip(legit marker) === true', () => {
    const real = new CancellationSkipMarker(7, FAKE_HASH);
    expect(isCancellationSkip(real)).toBe(true);
  });

  it('isCancellationSkip(plain Error) === false', () => {
    const plain = new Error('Cancellation skip marker (rowNumber=42)');
    expect(isCancellationSkip(plain)).toBe(false);
  });

  it('isCancellationSkip(unrelated subclass) === false', () => {
    class SomethingElse extends Error {}
    const other = new SomethingElse('Cancellation skip marker');
    expect(isCancellationSkip(other)).toBe(false);
  });

  it('isCancellationSkip(shadow class with same NAME but different identity) === false', () => {
    // Simulates a 3rd-party lib defining its own `CancellationSkipMarker`
    // class via the same name. Without the brand check, `instanceof`
    // would mis-classify ANY instance of this shadow class as
    // belonging to our module. The Symbol brand prevents this — the
    // shadow class has its own (or no) brand value.
    class CancellationSkipMarker extends Error {}
    const imposter = new CancellationSkipMarker('Cancellation skip marker');
    expect(isCancellationSkip(imposter)).toBe(false);
  });

  it('isCancellationSkip(object with matching _csvSkipBrand string but wrong instance) === false', () => {
    // Even if a future attacker constructs a plain object with the
    // (private) brand-key, the `instanceof CancellationSkipMarker`
    // gate still fires first.
    const fake = {
      _csvSkipBrand: Symbol.for('f6.csv-skip.cancellation'),
      rowNumber: 1,
      emailHash: FAKE_HASH,
    };
    expect(isCancellationSkip(fake)).toBe(false);
  });

  it('isCancellationSkip(null / undefined / non-Error) === false', () => {
    expect(isCancellationSkip(null)).toBe(false);
    expect(isCancellationSkip(undefined)).toBe(false);
    expect(isCancellationSkip('plain string')).toBe(false);
    expect(isCancellationSkip({ rowNumber: 1 })).toBe(false);
    expect(isCancellationSkip(123)).toBe(false);
  });

  it('hashAttendeeEmail produces a 16-char lowercase hex string', () => {
    const hash = hashAttendeeEmail('Test@Example.Com');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(hash).not.toContain('@');
    // Lowercase invariant — `'Test@Example.Com'` and `'test@example.com'`
    // MUST produce the same hash so support correlation works
    // regardless of case at upload time.
    expect(hash).toBe(hashAttendeeEmail('test@example.com'));
  });

  it('hashAttendeeEmail is deterministic across calls (same input → same output)', () => {
    const a = hashAttendeeEmail('determinism@example.test');
    const b = hashAttendeeEmail('determinism@example.test');
    expect(a).toBe(b);
  });

  it('hashAttendeeEmail produces distinct hashes for distinct inputs', () => {
    const a = hashAttendeeEmail('one@example.test');
    const b = hashAttendeeEmail('two@example.test');
    expect(a).not.toBe(b);
  });
});
