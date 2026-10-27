/**
 * Spec 122 follow-up PR F (27 Oct 2026) — the seeded tier segment definitions.
 *
 * Migration 0068 seeded `swecham` tier presets with the codes premium, large,
 * regular, diamond, platinum and gold. The recipient query matches only the
 * two `plan_category` values, so each preset would reach nobody (the PR D
 * bug, in data). Migration 0321 replaces them with one preset per category.
 *
 * Read through the owner `db` (BYPASSRLS), so every tenant is checked.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import en from '@/i18n/messages/en.json';

const CATEGORIES = ['corporate', 'partnership'];

type TierRow = {
  tenant_id: string;
  params: { tierCodes?: unknown } | null;
  display_label_i18n_key: string;
};

async function tierRows(): Promise<TierRow[]> {
  return (await db.execute(sql`
    SELECT tenant_id, params, display_label_i18n_key
      FROM broadcast_segment_definitions
     WHERE segment_type = 'tier'
  `)) as unknown as TierRow[];
}

function hasMessage(key: string): boolean {
  let node: unknown = en;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string';
}

describe('seeded tier segment definitions (migration 0321)', () => {
  it('no tier definition in any tenant names a code outside the two categories', async () => {
    const bad = (await tierRows()).filter(({ params }) => {
      const codes = params?.tierCodes;
      return (
        !Array.isArray(codes) ||
        codes.length === 0 ||
        codes.some((c) => typeof c !== 'string' || !CATEGORIES.includes(c))
      );
    });
    expect(bad).toEqual([]);
  });

  it('swecham has one preset per category, each with a label that exists', async () => {
    const rows = (await tierRows()).filter((r) => r.tenant_id === 'swecham');
    expect(rows.map((r) => r.params?.tierCodes).sort()).toEqual([['corporate'], ['partnership']]);
    for (const r of rows) expect(hasMessage(r.display_label_i18n_key), r.display_label_i18n_key).toBe(true);
  });
});
