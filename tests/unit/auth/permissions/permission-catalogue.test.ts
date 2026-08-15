/**
 * T003 — Domain test: permission catalogue (016-rbac-permissions PR 1).
 *
 * Pins the catalogue to the § 4.1 design table via tests/helpers/rbac-pinned-matrix:
 * key grammar (dot-separated, never the legacy colon), uniqueness, the exact
 * 40-key set, and the superAdminOnly / sensitive flags (spec FR-002, FR-003).
 */

import { describe, expect, it } from 'vitest';

import { PERMISSION_CATALOGUE } from '@/modules/auth/domain/permissions/permission-catalogue';

import {
  PINNED_KEYS,
  PINNED_MATRIX,
  PINNED_SUPER_ADMIN_ONLY,
} from '../../../helpers/rbac-pinned-matrix';

describe('permission catalogue (§ 4.1 pinned)', () => {
  it('every key is <module>.<action> — lowercase, DOT separator, no colon', () => {
    for (const entry of PERMISSION_CATALOGUE) {
      expect(entry.key).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });

  it('keys are unique', () => {
    const keys = PERMISSION_CATALOGUE.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('contains exactly the 40 pinned § 4.1 keys', () => {
    const keys = PERMISSION_CATALOGUE.map((e) => e.key).sort();
    expect(keys).toEqual([...PINNED_KEYS].sort());
    expect(keys).toHaveLength(41);
  });

  it('superAdminOnly flags match the pinned set exactly', () => {
    const saKeys = PERMISSION_CATALOGUE.filter((e) => e.superAdminOnly === true)
      .map((e) => e.key)
      .sort();
    expect(saKeys).toEqual([...PINNED_SUPER_ADMIN_ONLY].sort());
    expect(saKeys).toHaveLength(6);
  });

  it('sensitive flags (money | pii) match the pinned table per key', () => {
    const byKey = new Map(PERMISSION_CATALOGUE.map((e) => [e.key, e]));
    for (const pinned of PINNED_MATRIX) {
      const entry = byKey.get(pinned.key);
      expect(entry, pinned.key).toBeDefined();
      expect(entry?.sensitive, pinned.key).toBe(pinned.sensitive);
    }
  });
});
