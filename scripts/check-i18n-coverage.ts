/**
 * i18n coverage check (T053, spec FR-014 / SC-007).
 *
 * Walks `src/i18n/messages/{en,th,sv}.json` and asserts:
 *
 *   1. Every key present in en.json is ALSO present in th.json + sv.json.
 *      Missing keys produce a WARNING in dev (CI also exits 0) and an
 *      ERROR on release branches (CI exits non-zero).
 *
 *   2. The release-branch behaviour matches `docs/ux-standards.md` § 12,
 *      which is stricter than spec FR-014 — both are honoured per the
 *      precedence rule documented in FR-014.
 *
 * Run via `pnpm check:i18n`. The script is intentionally a single file
 * with no dependencies so it can run in any environment.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const MESSAGES_DIR = resolve(process.cwd(), 'src', 'i18n', 'messages');
const LOCALES = ['en', 'th', 'sv'] as const;
type Locale = (typeof LOCALES)[number];

const RELEASE_BRANCH_PATTERN = /^(main|release\/.+)$/;
const branch = process.env.GITHUB_REF_NAME ?? process.env.BRANCH ?? '';
const isReleaseBranch = RELEASE_BRANCH_PATTERN.test(branch);

async function loadMessages(locale: Locale): Promise<Record<string, unknown>> {
  const path = resolve(MESSAGES_DIR, `${locale}.json`);
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

function flatten(prefix: string, value: unknown, out: Set<string>): void {
  if (value === null || typeof value !== 'object') {
    out.add(prefix);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    flatten(prefix ? `${prefix}.${key}` : key, child, out);
  }
}

async function main(): Promise<void> {
  const sets: Record<Locale, Set<string>> = {
    en: new Set(),
    th: new Set(),
    sv: new Set(),
  };

  for (const locale of LOCALES) {
    const messages = await loadMessages(locale);
    flatten('', messages, sets[locale]);
  }

  const enKeys = sets.en;
  const issues: string[] = [];

  for (const key of enKeys) {
    if (!sets.th.has(key)) issues.push(`th.json missing: ${key}`);
    if (!sets.sv.has(key)) issues.push(`sv.json missing: ${key}`);
  }

  // Extra keys in non-EN locales — warn but never fail
  for (const locale of ['th', 'sv'] as const) {
    for (const key of sets[locale]) {
      if (!enKeys.has(key)) {
        console.warn(`[check:i18n] ${locale}.json has key not in en.json: ${key}`);
      }
    }
  }

  if (issues.length === 0) {
    console.log(`[check:i18n] OK — ${enKeys.size} keys present in all 3 locales`);
    return;
  }

  for (const issue of issues) {
    console.error(`[check:i18n] ${issue}`);
  }

  if (isReleaseBranch) {
    console.error(
      `[check:i18n] FAILING — ${issues.length} missing translations on release branch (${branch}).`,
    );
    process.exitCode = 1;
  } else {
    console.warn(
      `[check:i18n] WARNING — ${issues.length} missing translations (would fail on release branches).`,
    );
  }
}

main().catch((error) => {
  console.error('[check:i18n] crashed:', error);
  process.exit(1);
});
