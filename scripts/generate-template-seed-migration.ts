/**
 * Generate F7.1a US7 starter-template seed migration (T008).
 *
 * Parses `specs/014-email-broadcast-advance/starter-templates.md` and
 * emits `drizzle/migrations/0134_f71a_default_template_seed.sql`.
 *
 * Why generated, not hand-written:
 *
 *   - The source-of-truth content lives in markdown so non-engineers
 *     (chamber compliance liaison, marketing) can review tone +
 *     phrasing without reading SQL. Drift between the markdown and
 *     the committed `.sql` would silently ship the wrong content to
 *     every new tenant — so a CI gate (`--check` mode, wired in
 *     `.github/workflows/template-seed-drift.yml`) regenerates and
 *     diffs on every PR that touches either file.
 *
 *   - The asserted invariant is "exactly 5 templates × 3 locales =
 *     15 rows". Anything else (4 templates, 2 locales, malformed
 *     subject) exits non-zero before producing partial SQL — catches
 *     markdown corruption before it reaches the seed step (FR-020).
 *
 * Modes:
 *
 *   pnpm tsx scripts/generate-template-seed-migration.ts
 *     → writes drizzle/migrations/0134_f71a_default_template_seed.sql
 *
 *   pnpm tsx scripts/generate-template-seed-migration.ts --check
 *     → generates in memory; diffs against the committed file;
 *       exit 0 if identical, exit 1 (with diff hint) on drift.
 *       CI gate uses this mode.
 *
 *   pnpm tsx scripts/generate-template-seed-migration.ts --print
 *     → writes to stdout instead of disk (debug aid).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, '..');
const SOURCE_MD = resolve(
  REPO_ROOT,
  'specs',
  '014-email-broadcast-advance',
  'starter-templates.md',
);
const TARGET_SQL = resolve(
  REPO_ROOT,
  'drizzle',
  'migrations',
  '0134_f71a_default_template_seed.sql',
);

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

const EXPECTED_TEMPLATE_COUNT = 5;
const LOCALES = ['en', 'th', 'sv'] as const;
type Locale = (typeof LOCALES)[number];
const EXPECTED_ROW_COUNT = EXPECTED_TEMPLATE_COUNT * LOCALES.length; // 15

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TemplateRow {
  readonly templateIndex: number; // 1-based, for error messages
  readonly templateLabel: string; // e.g. "Monthly Newsletter" (from ## header)
  readonly locale: Locale;
  readonly name: string;
  readonly subject: string;
  readonly bodyHtml: string;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * State machine — walks the markdown line-by-line and accumulates
 * one TemplateRow each time it sees a complete `### LOCALE` block
 * (Name + Subject + ```html …``` body).
 *
 * Intentionally strict: any deviation from the expected sequence
 * throws with the offending line number. Drift in the markdown
 * structure is a P1 bug (silent SQL corruption otherwise).
 */
function parseStarterTemplates(md: string): readonly TemplateRow[] {
  const lines = md.split(/\r?\n/);
  const rows: TemplateRow[] = [];

  let templateIndex = 0;
  let templateLabel: string | null = null;
  let locale: Locale | null = null;
  let name: string | null = null;
  let subject: string | null = null;
  let body: string | null = null;
  let inBody = false;

  const flush = (lineNo: number): void => {
    if (templateLabel === null || locale === null) return;
    if (name === null || subject === null || body === null) {
      throw new Error(
        `parse error at line ${lineNo}: incomplete ${locale.toUpperCase()} block ` +
          `for "${templateLabel}" (name=${name !== null}, subject=${subject !== null}, body=${body !== null})`,
      );
    }
    rows.push({
      templateIndex,
      templateLabel,
      locale,
      name,
      subject,
      bodyHtml: body,
    });
    locale = null;
    name = null;
    subject = null;
    body = null;
    inBody = false;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;

    // Body capture mode swallows everything until the closing fence.
    if (inBody) {
      if (line.trim() === '```') {
        inBody = false;
        continue;
      }
      body = body === null ? line : `${body}\n${line}`;
      continue;
    }

    // Template boundary: ## Template N: NAME
    const templateMatch = /^##\s+Template\s+(\d+)\s*:\s*(.+?)\s*$/.exec(line);
    if (templateMatch) {
      flush(lineNo); // close any pending locale block (defensive)
      const idx = Number(templateMatch[1]);
      if (!Number.isInteger(idx) || idx < 1) {
        throw new Error(`parse error at line ${lineNo}: template index "${templateMatch[1]}" not a positive integer`);
      }
      templateIndex = idx;
      templateLabel = templateMatch[2] ?? '';
      continue;
    }

    // Locale boundary: ### EN / TH / SV
    const localeMatch = /^###\s+(EN|TH|SV)\s*$/.exec(line);
    if (localeMatch) {
      flush(lineNo); // close previous locale block
      const candidate = (localeMatch[1] ?? '').toLowerCase() as Locale;
      if (!LOCALES.includes(candidate)) {
        throw new Error(`parse error at line ${lineNo}: unknown locale "${localeMatch[1]}"`);
      }
      locale = candidate;
      continue;
    }

    if (locale === null) continue;

    // Field captures inside an active locale block.
    const nameMatch = /^\*\*Name\*\*:\s*`([^`]+)`\s*$/.exec(line);
    if (nameMatch) {
      name = nameMatch[1] ?? '';
      continue;
    }
    const subjectMatch = /^\*\*Subject\*\*:\s*`([^`]+)`\s*$/.exec(line);
    if (subjectMatch) {
      subject = subjectMatch[1] ?? '';
      continue;
    }
    if (line.trim() === '```html') {
      if (body !== null) {
        throw new Error(`parse error at line ${lineNo}: nested html fence inside body of "${templateLabel}" ${locale.toUpperCase()}`);
      }
      body = '';
      inBody = true;
      continue;
    }
  }

  // Flush trailing block at EOF.
  flush(lines.length);

  return rows;
}

// ---------------------------------------------------------------------------
// SQL emitter
// ---------------------------------------------------------------------------

/**
 * Escape a string for inclusion inside a PostgreSQL single-quoted
 * literal. Doubles every internal single-quote. Backslashes are NOT
 * special inside non-E-prefixed string literals (Postgres
 * `standard_conforming_strings=on` is default since 9.1), so we
 * only need to handle the quote.
 */
function pgQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function emitSql(rows: readonly TemplateRow[]): string {
  const header = `-- F7.1a US7 default template seed (T019; FR-020) — AUTO-GENERATED.
--
-- DO NOT EDIT BY HAND. This file is regenerated by
-- \`pnpm tsx scripts/generate-template-seed-migration.ts\` from
-- \`specs/014-email-broadcast-advance/starter-templates.md\`.
-- CI gate \`.github/workflows/template-seed-drift.yml\` and the
-- pre-push hook both run with --check and fail on drift.
--
-- Seeds ${EXPECTED_TEMPLATE_COUNT} starter templates × ${LOCALES.length} locales =
-- ${EXPECTED_ROW_COUNT} rows per existing tenant. New tenants get seeded by
-- the onboarding flow (separate from this migration). The ON CONFLICT
-- clause makes the seed idempotent for re-application; the runtime
-- conflict-on-name detection + audit event emit happens in the
-- onboarding use-case, NOT in this migration.

DO $do$
DECLARE
  t_id uuid;
BEGIN
  FOR t_id IN SELECT id FROM tenants LOOP
    INSERT INTO broadcast_templates
      (tenant_id, name, subject, body_html, locale, is_seeded)
    VALUES`;

  const valueRows = rows
    .map((r) =>
      `      (t_id, ${pgQuote(r.name)}, ${pgQuote(r.subject)}, ` +
      `${pgQuote(r.bodyHtml)}, ${pgQuote(r.locale)}, TRUE)`,
    )
    .join(',\n');

  const footer = `
    ON CONFLICT ON CONSTRAINT broadcast_templates_tenant_name_locale_uniq DO NOTHING;
  END LOOP;
END $do$;
`;

  return `${header}\n${valueRows}${footer}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = new Set(process.argv.slice(2));
  const checkMode = args.has('--check');
  const printMode = args.has('--print');

  if (!existsSync(SOURCE_MD)) {
    console.error(`[generate-template-seed] source not found: ${SOURCE_MD}`);
    process.exit(1);
  }

  const md = readFileSync(SOURCE_MD, 'utf8');
  let rows: readonly TemplateRow[];
  try {
    rows = parseStarterTemplates(md);
  } catch (err) {
    console.error('[generate-template-seed] parse failed:', (err as Error).message);
    process.exit(1);
  }

  if (rows.length !== EXPECTED_ROW_COUNT) {
    console.error(
      `[generate-template-seed] expected ${EXPECTED_ROW_COUNT} rows ` +
        `(${EXPECTED_TEMPLATE_COUNT} templates × ${LOCALES.length} locales), got ${rows.length}.`,
    );
    process.exit(1);
  }

  // Sanity: 3 rows per template (1 each EN/TH/SV) in order
  for (let i = 0; i < EXPECTED_TEMPLATE_COUNT; i += 1) {
    const slice = rows.slice(i * LOCALES.length, (i + 1) * LOCALES.length);
    const expectedLocales = [...LOCALES];
    for (let j = 0; j < slice.length; j += 1) {
      const expected = expectedLocales[j];
      const actual = slice[j]?.locale;
      if (expected !== actual) {
        console.error(
          `[generate-template-seed] template ${i + 1} ("${slice[j]?.templateLabel}") ` +
            `expected locale ${expected} at position ${j}, got ${actual}`,
        );
        process.exit(1);
      }
    }
  }

  const sql = emitSql(rows);

  if (printMode) {
    process.stdout.write(sql);
    return;
  }

  if (checkMode) {
    if (!existsSync(TARGET_SQL)) {
      console.error(
        `[generate-template-seed] --check FAIL: ${TARGET_SQL} does not exist.\n` +
          `  Run \`pnpm tsx scripts/generate-template-seed-migration.ts\` to generate it.`,
      );
      process.exit(1);
    }
    const committed = readFileSync(TARGET_SQL, 'utf8').replace(/\r\n/g, '\n');
    const generated = sql.replace(/\r\n/g, '\n');
    if (committed !== generated) {
      console.error(
        `[generate-template-seed] --check FAIL: drift between starter-templates.md and ${TARGET_SQL}.\n` +
          `  Run \`pnpm tsx scripts/generate-template-seed-migration.ts\` and commit the result.`,
      );
      process.exit(1);
    }
    console.log(`[generate-template-seed] --check OK (${rows.length} rows, no drift)`);
    return;
  }

  writeFileSync(TARGET_SQL, sql, { encoding: 'utf8' });
  console.log(
    `[generate-template-seed] wrote ${TARGET_SQL} (${rows.length} rows; ` +
      `${EXPECTED_TEMPLATE_COUNT} templates × ${LOCALES.length} locales).`,
  );
}

main();
