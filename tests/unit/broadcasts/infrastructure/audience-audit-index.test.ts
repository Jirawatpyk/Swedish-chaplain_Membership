/**
 * Spec 143 (TT1) — migration 0328 and `scripts/verify-schema.ts` carry the
 * text of `audience-audit-index.ts`; these cells pin each copy to the constants.
 *
 * They read files only, so they live in the unit suite: a drift between the
 * migration and the constants fails `pnpm test`, not only the live-Neon run.
 * The cells that execute the check and the canary against dev's index stay in
 * `tests/integration/broadcasts/audience-audit-rows.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  AUDIENCE_DELETED_INDEX_DEF,
  AUDIENCE_DELETED_KEY_SQL,
  AUDIENCE_DELETED_PREDICATE_SQL,
  normaliseIndexDefSql,
} from '@/modules/broadcasts/infrastructure/db/audience-audit-index';

const MIGRATION = join(process.cwd(), 'drizzle', 'migrations', '0328_audit_log_audience_deleted_once.sql');

/** The migration's statement that contains every `marker`, verbatim from the file. */
function migrationBlock(...markers: string[]): string {
  const block = readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .find((s) => markers.every((m) => s.includes(m)));
  expect(block).toBeDefined();
  return block!;
}

/** The index-definition check (the `DO $$` block after the CREATE). */
const indexCheckSql = () => migrationBlock('DO $$', 'has another definition');

/** A SQL string literal's body (quotes doubled) back to its value. */
const unquote = (body: string) => body.replaceAll("''", "'");

describe('spec 143 TT1 — migration 0328 and verify-schema spell audience-audit-index.ts', () => {
  it("the migration's v_expected and normalisation are AUDIENCE_DELETED_INDEX_DEF and normaliseIndexDefSql (CR4 #5)", () => {
    const check = indexCheckSql();
    const m = /v_expected constant text := '((?:[^']|'')*)';/.exec(check);
    expect(m).not.toBeNull();
    expect(unquote(m![1]!)).toBe(AUDIENCE_DELETED_INDEX_DEF);
    expect(check).toContain(normaliseIndexDefSql('v_def'));
    expect(check).toContain(normaliseIndexDefSql('v_expected'));
  });

  it("the migration's CREATE has the key and the predicate of audience-audit-index.ts", () => {
    const create = migrationBlock('CREATE UNIQUE INDEX IF NOT EXISTS').replaceAll('"', '').replace(/\s+/g, ' ');
    expect(create).toContain(
      `CREATE UNIQUE INDEX IF NOT EXISTS audit_log_audience_deleted_once ON audit_log ${AUDIENCE_DELETED_KEY_SQL} WHERE ${AUDIENCE_DELETED_PREDICATE_SQL};`,
    );
  });

  // Review round 1 (code-review #5): the script runs the module's canary query
  // as it is, so the live cell executes the script's own text and a typo in it
  // (the to_regclass name included) fails that cell.
  it('the verify-schema canary is AUDIENCE_DELETED_INDEX_CANARY_SQL from audience-audit-index.ts', () => {
    const source = readFileSync(join(process.cwd(), 'scripts', 'verify-schema.ts'), 'utf8');
    expect(source).toMatch(/from '\.\.\/src\/modules\/broadcasts\/infrastructure\/db\/audience-audit-index'/);
    expect(source).toContain('query: AUDIENCE_DELETED_INDEX_CANARY_SQL,');
    // The query has no second copy in the script (its name line may name the index).
    expect(source).not.toContain('CREATE UNIQUE INDEX audit_log_audience_deleted_once');
    expect(source).not.toMatch(/to_regclass\('public\.audit_log_audience_deleted_once'\)/);
  });
});
