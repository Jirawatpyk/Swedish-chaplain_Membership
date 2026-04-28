/**
 * DEV-ONLY — apply T166 migrations 0056 + 0057 + 0058.
 *
 * The drizzle-kit migrate auto-runner is wedged on this Neon branch
 * (DB has 66 applied entries vs journal's 56 — historical re-syncs
 * mean drizzle can't reconcile). Same pattern as
 * `dev-apply-migration-0049.ts` for the F5 audit-event extensions.
 *
 *   0056 — async receipt PDF state machine
 *           (enum + 3 columns + CHECK constraint + backfill + index)
 *   0057 — audit_event_type adds receipt_rendered + pdf_render_permanently_failed
 *   0058 — notification_type adds receipt_pdf_render
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const lower = url.toLowerCase();
  if (
    process.env.NODE_ENV === 'production' ||
    lower.includes('vercel-storage') ||
    lower.includes('-prod') ||
    lower.includes('.prod.') ||
    lower.includes('-live') ||
    lower.includes('.live.')
  ) {
    throw new Error(
      'REFUSED: production-looking DATABASE_URL. Set DEV_SCRIPT_FORCE=1 to bypass.',
    );
  }
  const client = postgres(url, { max: 1 });
  try {
    // Apply each migration individually. Each file uses
    // `IF NOT EXISTS` / `EXCEPTION duplicate_object` guards so re-runs
    // are safe.
    for (const tag of [
      '0056_async_receipt_pdf',
      '0057_audit_log_receipt_rendered',
      '0058_notification_type_receipt_pdf_render',
    ]) {
      const path = resolve(`drizzle/migrations/${tag}.sql`);
      const sql = readFileSync(path, 'utf8');
      // Drizzle migration files use `--> statement-breakpoint` to
      // delimit statements; split + run each one separately.
      const statements = sql
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      console.log(`Applying ${tag} (${statements.length} statements)…`);
      for (const stmt of statements) {
        await client.unsafe(stmt);
      }
      console.log(`✓ ${tag} applied`);
    }
  } finally {
    await client.end();
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
