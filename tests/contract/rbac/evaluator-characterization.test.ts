/**
 * T006 — Contract: evaluator-level characterization rows
 * (016-rbac-permissions; design § 10, contract § 4 "characterization").
 *
 * ON-leg-only since PR 5 (T068). The legacy-leg characterization — the
 * anti-circularity anchor that held `hasPermission(role, key, {rbacV2:false,
 * legacy})` byte-identical to the observed `canAccess` — died WITH `canAccess`
 * and the shim: both sides of that equation were deleted in the same commit,
 * so the contract it protected can no longer be violated. What remains
 * load-bearing is the § 4.1 matrix pin and the purity discipline.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  getPermissionSet,
  hasPermission,
} from '@/modules/auth/domain/permissions/evaluator';
import type { PermissionKey } from '@/modules/auth/domain/permissions/permission-catalogue';

import { PINNED_MATRIX } from '../../helpers/rbac-pinned-matrix';

const key = (k: string) => k as PermissionKey;

describe('the evaluator reproduces the pinned § 4.1 matrix exactly', () => {
  it.each(PINNED_MATRIX.map((r) => [r.key, r] as const))('%s', (_k, pinned) => {
    expect(hasPermission('super_admin', key(pinned.key))).toBe(true);
    expect(hasPermission('admin', key(pinned.key))).toBe(pinned.admin);
    expect(hasPermission('manager', key(pinned.key))).toBe(pinned.manager);
    expect(hasPermission('marketing', key(pinned.key))).toBe(pinned.marketing);
    expect(hasPermission('member', key(pinned.key))).toBe(false);
  });
});

describe('environment discipline (design § 10)', () => {
  it('the deleted flag has not crept back into tests/setup.ts', () => {
    // Source scan, not an env probe. The flag is DELETED in PR 5 — any
    // reappearance here means someone resurrected a leg switch in the one
    // file every suite inherits from, which is how a "both legs" claim went
    // silently single-legged once before (design § 10).
    const setup = readFileSync(join(process.cwd(), 'tests', 'setup.ts'), 'utf8');
    expect(setup).not.toMatch(/FEATURE_RBAC_V2/);
  });

  it('getPermissionSet is synchronous and env-independent (D15 purity)', () => {
    const first = getPermissionSet('manager');
    expect(first).toBeInstanceOf(Set);
    // Deterministic across calls — no memoised mutable state.
    expect([...getPermissionSet('manager')].sort()).toEqual([...first].sort());
  });
});
