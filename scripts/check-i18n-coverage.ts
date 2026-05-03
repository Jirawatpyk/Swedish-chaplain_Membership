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

/**
 * Feature-required namespaces. Dropping any of these from en.json is a
 * hard error (CI fails immediately) because the feature surface can't
 * render without them. F2 adds `admin.plans.*` + `palette.*` — extended
 * here per task T060. R8 consolidation retired `admin.settings.fees.*`
 * (Fee Configuration page deleted; VAT + currency + registration fee
 * moved to `admin.invoiceSettings.*`).
 */
const REQUIRED_NAMESPACES = [
  // F1 — auth surfaces + shell + admin users
  'auth.signIn',
  'auth.signOut',
  'auth.forgotPassword',
  'auth.resetPassword',
  'auth.changePassword',
  'auth.invite',
  'shell',
  'buttons',
  'errors',
  'admin.users',
  // F2 — plans + command palette
  'admin.plans',
  'palette',
  // F4 — invoicing (R7 + R8 consolidation)
  'admin.invoiceSettings',
  'admin.invoices',
] as const;

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

/**
 * T040 — F5 sub-folder catalogue validation. The top-20 Stripe
 * decline-reason catalogue lives under `messages/{locale}/payment-
 * decline-reasons.json` (separate files per locale — the main
 * `{locale}.json` loader doesn't include it because it's loaded
 * lazily on error rendering only). This helper asserts the key set
 * is identical across the 3 locales; any drift (missing / extra
 * keys) fails release-branch builds and warns elsewhere.
 */
async function loadSubCatalogue(
  locale: Locale,
  file: string,
): Promise<Record<string, unknown>> {
  const path = resolve(MESSAGES_DIR, locale, file);
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

async function checkSubCatalogueKeyParity(
  file: string,
  label: string,
  issues: string[],
): Promise<void> {
  const sets: Record<Locale, Set<string>> = {
    en: new Set(),
    th: new Set(),
    sv: new Set(),
  };
  for (const locale of LOCALES) {
    try {
      const data = await loadSubCatalogue(locale, file);
      for (const key of Object.keys(data)) sets[locale].add(key);
    } catch (err) {
      issues.push(`${label}: ${locale}/${file} failed to load (${(err as Error).message})`);
      return;
    }
  }
  for (const key of sets.en) {
    if (!sets.th.has(key)) issues.push(`${label}: th/${file} missing key ${key}`);
    if (!sets.sv.has(key)) issues.push(`${label}: sv/${file} missing key ${key}`);
  }
  for (const locale of ['th', 'sv'] as const) {
    for (const key of sets[locale]) {
      if (!sets.en.has(key)) {
        console.warn(
          `[check:i18n] ${label}: ${locale}/${file} has key not in en/${file}: ${key}`,
        );
      }
    }
  }
}

/**
 * T187 (Phase 10 / i18n.md CHK054) — orphan-key scanner.
 *
 * Finds keys present in `en.json` but NEVER referenced via `t('foo')`
 * or `t('foo.bar')` calls in `src/`. Orphans are dead translations
 * that bloat bundles and confuse i18n liaison reviews.
 *
 * The scanner accepts a literal-only argument extraction (matching
 * T188's static-key invariant ESLint rule) — it does NOT try to
 * resolve variable namespaces or `getTranslations({namespace})`
 * dynamic prefixes. Static `t('error.too_long')` / `t('shell.userMenu')`
 * patterns + `getTranslations('admin.plans')` namespace prefixes are
 * recognised; everything else is conservatively assumed used.
 */
async function findOrphans(enKeys: Set<string>): Promise<string[]> {
  const { readdir, stat } = await import('node:fs/promises');
  const used = new Set<string>();
  const namespaces: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir);
    for (const entry of entries) {
      const path = resolve(dir, entry);
      const s = await stat(path);
      if (s.isDirectory()) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        await walk(path);
      } else if (
        entry.endsWith('.ts') ||
        entry.endsWith('.tsx') ||
        entry.endsWith('.js')
      ) {
        const text = await readFile(path, 'utf8');
        // t('foo.bar') and t("foo.bar")
        const tCallRe = /\bt\(\s*['"]([\w.\-]+)['"]/g;
        let m: RegExpExecArray | null;
        while ((m = tCallRe.exec(text)) !== null) used.add(m[1]!);
        // getTranslations('namespace.path')
        const nsRe = /getTranslations\(\s*['"]([\w.\-]+)['"]/g;
        while ((m = nsRe.exec(text)) !== null) namespaces.push(m[1]!);
        // useTranslations('namespace.path')
        const useNsRe = /useTranslations\(\s*['"]([\w.\-]+)['"]/g;
        while ((m = useNsRe.exec(text)) !== null) namespaces.push(m[1]!);
      }
    }
  }

  await walk(resolve(process.cwd(), 'src'));

  // For each enKey, count it as used if:
  //   - exactly matches a `t('full.key')` call, OR
  //   - any of its prefixes is a known namespace + the suffix is a
  //     `t('suffix')` call.
  const orphans: string[] = [];
  for (const key of enKeys) {
    if (used.has(key)) continue;
    let foundViaNs = false;
    for (const ns of namespaces) {
      if (key.startsWith(`${ns}.`)) {
        const suffix = key.slice(ns.length + 1);
        if (used.has(suffix)) {
          foundViaNs = true;
          break;
        }
        // Conservative: if any t() call exactly matches a leaf of this
        // namespace, allow keys nested under it. This avoids false-
        // positive orphan flags on dynamic key composition.
        for (const u of used) {
          if (u === suffix || suffix.startsWith(`${u}.`) || u.startsWith(`${suffix}.`)) {
            foundViaNs = true;
            break;
          }
        }
        if (foundViaNs) break;
      }
    }
    if (!foundViaNs) orphans.push(key);
  }
  return orphans.sort();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const orphansMode = argv.includes('--orphans');

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

  // Hard-fail namespace check: every feature-required namespace MUST
  // have at least one key present in en.json. This catches structural
  // drops (e.g. a refactor that deletes `admin.plans` wholesale) that
  // the key-by-key comparison below would silently accept if the
  // namespace is also absent from th/sv.
  for (const ns of REQUIRED_NAMESPACES) {
    const hasAny = [...enKeys].some((k) => k === ns || k.startsWith(`${ns}.`));
    if (!hasAny) {
      console.error(
        `[check:i18n] HARD FAIL — required namespace "${ns}" is missing from en.json`,
      );
      process.exitCode = 1;
    }
  }

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

  // T040 — F5 decline-reason sub-catalogue key-set parity
  await checkSubCatalogueKeyParity(
    'payment-decline-reasons.json',
    'F5 decline-reasons',
    issues,
  );

  if (orphansMode) {
    const orphans = await findOrphans(enKeys);
    if (orphans.length === 0) {
      console.log(
        `[check:i18n --orphans] OK — every en.json key is referenced from src/`,
      );
      return;
    }
    console.warn(
      `[check:i18n --orphans] ${orphans.length} potentially orphan keys (review for dead translations):`,
    );
    for (const key of orphans) console.warn(`  - ${key}`);
    // Orphan check is advisory — never fails CI; missing keys still do.
    if (issues.length === 0) return;
  }

  if (issues.length === 0) {
    console.log(
      `[check:i18n] OK — ${enKeys.size} keys present in all 3 locales (+ F5 decline-reasons parity verified)`,
    );
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
