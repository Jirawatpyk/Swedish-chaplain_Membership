/**
 * Spec 143 — migration 0328's statements, read verbatim from the file, for the
 * unit pins (`audience-audit-index.test.ts`) and the live cells
 * (`audience-audit-rows.test.ts`) that execute them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MIGRATION_0328_PATH = join(process.cwd(), 'drizzle', 'migrations', '0328_audit_log_audience_deleted_once.sql');

/** The migration's statement that contains every `marker`; throws when none does. */
export function migration0328Block(...markers: string[]): string {
  const block = readFileSync(MIGRATION_0328_PATH, 'utf8')
    .split('--> statement-breakpoint')
    .find((s) => markers.every((m) => s.includes(m)));
  if (block === undefined) throw new Error(`migration 0328 has no statement containing ${JSON.stringify(markers)}`);
  return block;
}

/** The duplicate-key pre-check (the `DO $$` block before the CREATE). */
export const migration0328PreCheckSql = (): string => migration0328Block('DO $$', 'duplicate keys');

/** The index-definition check (the `DO $$` block after the CREATE). */
export const migration0328IndexCheckSql = (): string => migration0328Block('DO $$', 'has another definition');
