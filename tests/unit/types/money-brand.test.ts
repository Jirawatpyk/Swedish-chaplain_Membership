/**
 * F5R5 BLOCKER fix (2026-05-16) — TYPE-LEVEL contract test for the
 * `Satang` vs `UntrustedSatang` disjoint-sibling brand split.
 *
 * Background: R4 review proved the previous (R3v4) nested-brand
 * shape (`UntrustedSatang = bigint & {SatangBrand; UntrustedBrand}`,
 * subtype of `Satang`) was structurally INVERTED — UntrustedSatang
 * was freely assignable to Satang, and `addSatang(unchecked, valid)`
 * compiled clean despite the docstring's compile-time-enforcement
 * claim. The bug shipped because we had NO type-level test pinning
 * the safety guarantee — only the runtime `asSatang` throw protected
 * us, which is exactly the "policy-only enforcement" gap R3v3 was
 * trying to close.
 *
 * This file uses `@ts-expect-error` to assert that the FIVE shapes
 * SHOULD be compile errors. If a future change collapses the brands
 * back into a nested/structural shape, this file fails compilation
 * (because each `@ts-expect-error` comment becomes "unused" and
 * itself errors) — caught at `pnpm typecheck` before merge.
 *
 * Runtime execution is intentionally INERT — the type-level
 * assertions live in a dead-code function that is referenced (so
 * the bundler keeps it for type-checking) but never invoked at
 * runtime. The runtime `it(...)` body just asserts the legal
 * direction still works as a sanity check.
 */
import { describe, expect, it } from 'vitest';
import {
  asSatang,
  asSatangUnchecked,
  addSatang,
  subSatang,
  type Satang,
  type UntrustedSatang,
} from '@/lib/money';

// Dead-code function — exists ONLY to host the `@ts-expect-error`
// type-level assertions. NEVER invoked at runtime. If a future
// refactor collapses the brand back into a nested/structural shape,
// each `@ts-expect-error` becomes a "ts-expect-error: unused" error
// at compile time → `pnpm typecheck` fails → caught before merge.
function _typeOnlyBrandDisciplineProof(): void {
  const valid: Satang = asSatang(100n);
  const unchecked: UntrustedSatang = asSatangUnchecked(-50n);

  // (1) UntrustedSatang must NOT flow into a Satang slot.
  // @ts-expect-error — UntrustedSatang is NOT assignable to Satang
  const _back: Satang = unchecked;

  // (2) Satang must NOT flow into an UntrustedSatang slot (siblings).
  // @ts-expect-error — Satang is NOT assignable to UntrustedSatang
  const _fwd: UntrustedSatang = valid;

  // (3+4+5) addSatang/subSatang must REJECT UntrustedSatang.
  // @ts-expect-error — addSatang accepts only Satang
  const _fold1 = addSatang(unchecked, valid);
  // @ts-expect-error — addSatang accepts only Satang
  const _fold2 = addSatang(valid, unchecked);
  // @ts-expect-error — subSatang accepts only Satang
  const _fold3 = subSatang(unchecked, valid);

  // Touch the locals so unused-var doesn't lint-fail.
  void _back;
  void _fwd;
  void _fold1;
  void _fold2;
  void _fold3;
}

describe('Satang ↔ UntrustedSatang brand discipline (type-level)', () => {
  it('compile-time @ts-expect-error directives pin the 5 unsafe shapes', () => {
    // Reference the dead-code function so TS keeps type-checking it
    // (referenced but never invoked → runtime is inert; compile-time
    // assertions inside _typeOnlyBrandDisciplineProof are still
    // enforced). If brands collapse back to nested shape, `pnpm
    // typecheck` fails on the now-unused @ts-expect-error markers.
    expect(_typeOnlyBrandDisciplineProof).toBeDefined();
    expect(_typeOnlyBrandDisciplineProof.name).toBe(
      '_typeOnlyBrandDisciplineProof',
    );
    // Sanity: legal direction still works at runtime.
    expect(addSatang(asSatang(100n), asSatang(50n))).toBe(150n);
    expect(asSatangUnchecked(-50n)).toBe(-50n);
  });
});
