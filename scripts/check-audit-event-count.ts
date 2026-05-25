/**
 * R002 — audit-event count drift check.
 *
 * Prevents the "15 vs 16 F5 audit events" class of bug: the canonical
 * F5 audit enum lives in `drizzle/migrations/0040_audit_log_f5_extension.sql`
 * and the Drizzle schema extension in `src/modules/auth/infrastructure/db/schema.ts`.
 * Spec prose under every .md in `specs/009-online-payment/` and checklists
 * repeat the count in natural language — those repetitions have
 * historically drifted when the enum grows.
 *
 * This script:
 *   1. Parses all `ADD VALUE 'payment_*' | 'refund_*' | ...` statements
 *      from `drizzle/migrations/0040_audit_log_f5_extension.sql` to
 *      compute the canonical F5 event count.
 *   2. Greps every .md under `specs/009-online-payment/` (excluding the reviews
 *      directory — review reports record point-in-time state) for
 *      prose that quantifies the F5 event count: patterns like
 *      `N F5` / `N F5-introduced` / `all N F5` / `all N event types`
 *      where N is a digit sequence.
 *   3. Exits non-zero if any prose N differs from the canonical count.
 *
 * Run via `pnpm check:audit-events`. Zero dependencies — single file.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const ROOT = process.cwd();
/**
 * Canonical F5 audit event types live across multiple migrations:
 *   - 0040 — original 16 payment + refund + webhook + settings events
 *   - 0043 — 2 rate-limit events (Threat F-09, Group F Review-Gate)
 *
 * Add any future F5-scoped `ALTER TYPE audit_event_type ADD VALUE`
 * migration to this list so the drift-check stays truthful.
 */
const F5_MIGRATIONS = [
  resolve(ROOT, 'drizzle/migrations/0040_audit_log_f5_extension.sql'),
  resolve(ROOT, 'drizzle/migrations/0043_audit_log_rate_limit_events.sql'),
  resolve(
    ROOT,
    'drizzle/migrations/0046_audit_log_webhook_unknown_state_events.sql',
  ),
];
const SPEC_DIR = resolve(ROOT, 'specs/009-online-payment');
const REVIEWS_SUBDIR = 'reviews'; // Point-in-time reports — exempt from drift check.

// --- F9 (T014) — enum ↔ taxonomy parity --------------------------------------
// F9 audit event types live in TWO places that MUST stay in lockstep:
//   1. the Postgres `audit_event_type` enum (migration 0191 `ADD VALUE`s)
//   2. the TS `F9_AUDIT_EVENT_TYPES` tuple (insights audit port)
// This guard parses both from disk (no alias import) and fails on any drift —
// catches "added a label to the enum but forgot the taxonomy" (or vice-versa).
const F9_MIGRATION = resolve(
  ROOT,
  'drizzle/migrations/0191_f9_audit_event_types.sql',
);
const F9_PORT = resolve(
  ROOT,
  'src/modules/insights/application/ports/audit-port.ts',
);

// --- Canonical count ---------------------------------------------------------

async function computeCanonicalCount(): Promise<number> {
  let total = 0;
  for (const migration of F5_MIGRATIONS) {
    const sql = await readFile(migration, 'utf8');
    // F5 migrations use `ALTER TYPE … ADD VALUE '…'` inside DO blocks.
    // Match each ADD VALUE statement. Quote style is single-quote.
    const matches = sql.match(/ADD VALUE '[^']+'/g) ?? [];
    total += matches.length;
  }
  return total;
}

// --- Prose scan --------------------------------------------------------------

interface Mismatch {
  readonly file: string;
  readonly line: number;
  readonly claimed: number;
  readonly context: string;
}

// Patterns that quantify the F5 event count in prose. Each pattern MUST
// capture the number in group 1.
// Examples we want to catch:
//   "15 F5 audit event types"
//   "15 F5-introduced audit event"
//   "all 15 event types"
//   "all 15 F5 event types"
//   "(15 F5 + 17 F4)"
const PROSE_PATTERNS: readonly RegExp[] = [
  /\b(\d+)\s+F5(?:-introduced)?\s+(?:audit\s+)?event(?:\s+type)?s?\b/i,
  /\ball\s+(\d+)\s+(?:F5\s+)?(?:audit\s+)?event\s+types?\b/i,
  /\((\d+)\s+F5\s*\+\s*\d+\s+F4\)/i,
];

async function walkMarkdown(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) {
      if (entry === REVIEWS_SUBDIR) continue;
      out.push(...(await walkMarkdown(full)));
    } else if (entry.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

async function scanProse(canonical: number): Promise<Mismatch[]> {
  const mismatches: Mismatch[] = [];
  const files = await walkMarkdown(SPEC_DIR);
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (const pattern of PROSE_PATTERNS) {
        const match = line.match(pattern);
        if (!match) continue;
        const claimed = Number(match[1]);
        if (!Number.isFinite(claimed) || claimed === canonical) continue;
        mismatches.push({
          file: relative(ROOT, file),
          line: i + 1,
          claimed,
          context: line.trim(),
        });
      }
    }
  }
  return mismatches;
}

// --- F9 enum ↔ taxonomy parity (T014) ----------------------------------------

async function checkF9Parity(): Promise<boolean> {
  const migrationSql = await readFile(F9_MIGRATION, 'utf8');
  const enumLabels = new Set(
    (migrationSql.match(/ADD VALUE IF NOT EXISTS '([^']+)'/g) ?? []).map((m) =>
      m.replace(/.*'([^']+)'.*/, '$1'),
    ),
  );

  const portSrc = await readFile(F9_PORT, 'utf8');
  const tupleBlock = portSrc.match(
    /F9_AUDIT_EVENT_TYPES\s*=\s*\[([\s\S]*?)\]\s*as const/,
  )?.[1];
  const tupleLabels = new Set(
    (tupleBlock?.match(/'([a-z_]+)'/g) ?? []).map((s) => s.replace(/'/g, '')),
  );

  const onlyInEnum = [...enumLabels].filter((l) => !tupleLabels.has(l));
  const onlyInTuple = [...tupleLabels].filter((l) => !enumLabels.has(l));

  if (enumLabels.size === tupleLabels.size && onlyInEnum.length === 0 && onlyInTuple.length === 0) {
    console.log(
      `[check:audit-events] OK — F9 enum ↔ taxonomy parity: ${enumLabels.size} event types match (migration 0191 ↔ F9_AUDIT_EVENT_TYPES).`,
    );
    return true;
  }

  console.error(
    `[check:audit-events] F9 DRIFT — migration 0191 has ${enumLabels.size} ADD VALUE labels, ` +
      `F9_AUDIT_EVENT_TYPES has ${tupleLabels.size}.`,
  );
  if (onlyInEnum.length > 0) console.error(`  only in migration: ${onlyInEnum.join(', ')}`);
  if (onlyInTuple.length > 0) console.error(`  only in taxonomy:  ${onlyInTuple.join(', ')}`);
  return false;
}

// --- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  const canonical = await computeCanonicalCount();
  if (canonical === 0) {
    console.error(
      '[check:audit-events] FAIL — could not extract any ADD VALUE statements from F5 migrations. ' +
        `Files: ${F5_MIGRATIONS.map((p) => relative(ROOT, p)).join(', ')}`,
    );
    process.exit(1);
  }

  const mismatches = await scanProse(canonical);
  let ok = true;
  if (mismatches.length === 0) {
    console.log(
      `[check:audit-events] OK — canonical F5 audit-event count = ${canonical}; all prose references agree.`,
    );
  } else {
    ok = false;
    console.error(
      `[check:audit-events] DRIFT — canonical F5 audit-event count = ${canonical}, ` +
        `but ${mismatches.length} prose reference(s) disagree:`,
    );
    for (const m of mismatches) {
      console.error(
        `  ${m.file}:${m.line}  claims ${m.claimed}  →  ${m.context}`,
      );
    }
  }

  // F9 (T014) — enum ↔ taxonomy parity guard.
  if (!(await checkF9Parity())) ok = false;

  if (!ok) process.exit(1);
}

main().catch((error) => {
  console.error('[check:audit-events] crashed:', error);
  process.exit(1);
});
