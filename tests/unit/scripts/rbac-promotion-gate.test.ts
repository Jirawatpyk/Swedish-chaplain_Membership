/**
 * T036 — D7 promotion gate for `scripts/run-migrations.ts`.
 *
 * Migration C (the super_admin promotion, file tag `rbac_v2_promotion`) must
 * NEVER apply while `FEATURE_RBAC_V2` is not `'true'`: promoting admins on the
 * OFF leg would create rows whose capability silently DEGRADES (D16 maps
 * super_admin → admin) and, worse, applying C before the flag flip breaks the
 * strictly-ordered cutover the runbook mandates. The gate refuses the whole
 * migration run BEFORE any DDL when a PENDING promotion file is detected and
 * the flag is not 'true'.
 *
 * Pure-logic tests — the fs/db reads live in run-migrations.ts; this helper
 * decides, given (files, journal, applied set, flag value), whether to refuse.
 */
import { describe, expect, it } from 'vitest';
import {
  promotionGateFailure,
  RBAC_PROMOTION_TAG,
} from '../../../scripts/lib/rbac-promotion-gate';

const JOURNAL = [
  { tag: '0285_rbac_v2_role_enum', when: 1798541300000 },
  { tag: '0286_rbac_v2_denial_audit_and_union_guard', when: 1798541400000 },
  { tag: '0300_rbac_v2_promotion', when: 1798551400000 },
];

const FILES = [
  '0285_rbac_v2_role_enum.sql',
  '0286_rbac_v2_denial_audit_and_union_guard.sql',
  '0300_rbac_v2_promotion.sql',
];

describe('T036 D7 promotion gate', () => {
  it('exposes the naming contract Migration C must use', () => {
    expect(RBAC_PROMOTION_TAG).toBe('rbac_v2_promotion');
  });

  it('no promotion file present → proceed regardless of flag', () => {
    const files = FILES.filter((f) => !f.includes(RBAC_PROMOTION_TAG) || f.includes('role_enum') || f.includes('union_guard'));
    expect(
      promotionGateFailure({
        migrationFiles: ['0285_rbac_v2_role_enum.sql', '0286_rbac_v2_denial_audit_and_union_guard.sql'],
        journal: JOURNAL.slice(0, 2),
        appliedWhens: new Set(),
        flagValue: undefined,
      }),
    ).toBeNull();
    void files;
  });

  it('PENDING promotion + flag unset → refuse with file name + env var in the message', () => {
    const failure = promotionGateFailure({
      migrationFiles: FILES,
      journal: JOURNAL,
      appliedWhens: new Set([1798541300000, 1798541400000]),
      flagValue: undefined,
    });
    expect(failure).not.toBeNull();
    expect(failure).toContain('0300_rbac_v2_promotion');
    expect(failure).toContain('FEATURE_RBAC_V2');
  });

  it("PENDING promotion + flag 'false' → refuse", () => {
    expect(
      promotionGateFailure({
        migrationFiles: FILES,
        journal: JOURNAL,
        appliedWhens: new Set([1798541300000, 1798541400000]),
        flagValue: 'false',
      }),
    ).not.toBeNull();
  });

  it("PENDING promotion + flag 'true' → proceed (the sanctioned cutover path)", () => {
    expect(
      promotionGateFailure({
        migrationFiles: FILES,
        journal: JOURNAL,
        appliedWhens: new Set([1798541300000, 1798541400000]),
        flagValue: 'true',
      }),
    ).toBeNull();
  });

  it('promotion ALREADY APPLIED + flag later deleted (PR 5) → proceed', () => {
    expect(
      promotionGateFailure({
        migrationFiles: FILES,
        journal: JOURNAL,
        appliedWhens: new Set([1798541300000, 1798541400000, 1798551400000]),
        flagValue: undefined,
      }),
    ).toBeNull();
  });

  it('promotion file present but MISSING from the journal → refuse (misregistration)', () => {
    const failure = promotionGateFailure({
      migrationFiles: FILES,
      journal: JOURNAL.slice(0, 2),
      appliedWhens: new Set([1798541300000, 1798541400000]),
      flagValue: 'true',
    });
    expect(failure).not.toBeNull();
    expect(failure).toContain('journal');
  });
});
