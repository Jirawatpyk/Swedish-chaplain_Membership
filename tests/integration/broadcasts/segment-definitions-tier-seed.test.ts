/**
 * Spec 122 follow-up PR F (27 Oct 2026) — the seeded tier segment definitions.
 *
 * Migration 0068 seeded `swecham` tier presets with the codes premium, large,
 * regular, diamond, platinum and gold. The recipient query matches only the
 * two `plan_category` values, so each preset would reach nobody (the PR D
 * bug, in data). Migration 0321 replaces them with one preset per category.
 *
 * Read through the owner `db` (BYPASSRLS), so every real tenant is checked.
 * `test-*` tenants are left out: the shared dev branch is full of them, and
 * a leftover fixture there must not turn this red for everyone.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import en from '@/i18n/messages/en.json';
import th from '@/i18n/messages/th.json';
import sv from '@/i18n/messages/sv.json';

const CATEGORIES = ['corporate', 'partnership'];

type TierRow = {
  tenant_id: string;
  params: { tierCodes?: unknown } | null;
  display_label_i18n_key: string;
  enabled: boolean;
};

async function tierRows(): Promise<TierRow[]> {
  return (await db.execute(sql`
    SELECT tenant_id, params, display_label_i18n_key, enabled
      FROM broadcast_segment_definitions
     WHERE segment_type = 'tier' AND tenant_id NOT LIKE 'test-%'
  `)) as unknown as TierRow[];
}

/** The migration's own DELETE, the first statement of 0321. */
function migrationDelete(): string {
  const file = readFileSync(
    join(process.cwd(), 'drizzle/migrations/0321_fix_seeded_tier_segment_definitions.sql'),
    'utf8',
  );
  const stmt = file
    .split('--> statement-breakpoint')
    .map((part) => part.replace(/^\s*--.*$/gm, '').trim())
    .find((part) => part.startsWith('DELETE'));
  if (!stmt) throw new Error('0321 has no DELETE statement');
  return stmt.replace(/;\s*$/, '');
}

function hasMessage(messages: unknown, key: string): boolean {
  let node: unknown = messages;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string';
}

describe('seeded tier segment definitions (migration 0321)', () => {
  it('no tier definition in any real tenant names a code outside the two categories', async () => {
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

  it('swecham has an enabled preset per category, labelled in every locale', async () => {
    const rows = (await tierRows()).filter((r) => r.tenant_id === 'swecham');
    for (const category of CATEGORIES) {
      const preset = rows.find(
        (r) => JSON.stringify(r.params?.tierCodes) === JSON.stringify([category]),
      );
      expect(preset, category).toBeDefined();
      expect(preset?.enabled).toBe(true);
      for (const messages of [en, th, sv]) {
        expect(hasMessage(messages, preset?.display_label_i18n_key ?? ''), category).toBe(true);
      }
    }
  });

  it('its DELETE removes every malformed tier preset and keeps a valid one', async () => {
    const tenant = `test-tierseed-${randomUUID().slice(0, 8)}`;
    const shapes: ReadonlyArray<string | null> = [
      null,
      '{}',
      '{"tierCodes":null}',
      '{"tierCodes":"corporate"}',
      '{"tierCodes":[]}',
      '{"tierCodes":["corporate","gold"]}',
      '[]',
      '{"tierCodes":["partnership"]}',
    ];
    // Rolled back, so the malformed rows are never committed to the shared
    // dev branch: a crashed run cannot leave the first case red for everyone.
    const rollback = new Error('rollback');
    let left: Array<{ params: unknown }> = [];
    await db
      .transaction(async (tx) => {
        for (const shape of shapes) {
          await tx.execute(sql`
            INSERT INTO broadcast_segment_definitions
              (tenant_id, segment_type, display_label_i18n_key, params, enabled)
            VALUES (${tenant}, 'tier', 'portal.broadcasts.list.tierCode.partnership',
                    ${shape}::jsonb, true)
          `);
        }
        await tx.execute(sql`${sql.raw(migrationDelete())} AND tenant_id = ${tenant}`);
        left = (await tx.execute(sql`
          SELECT params FROM broadcast_segment_definitions WHERE tenant_id = ${tenant}
        `)) as unknown as Array<{ params: unknown }>;
        throw rollback;
      })
      .catch((e: unknown) => {
        if (e !== rollback) throw e;
      });
    expect(left.map((r) => r.params)).toEqual([{ tierCodes: ['partnership'] }]);
  });
});
