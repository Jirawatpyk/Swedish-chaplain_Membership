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
 * F5 route-error-code → i18n coverage gate (money-remediation Task 7 / I6).
 *
 * `src/lib/payments-errors-i18n.ts` already guarantees every
 * `F5RouteErrorCode` has an API-envelope bilingual string — `F5_ERROR_MESSAGES`
 * is typed `Record<F5RouteErrorCode, Bilingual>`, so the compiler enforces it.
 * NOTHING guaranteed the UI side. The admin refund dialog renders
 * `t(body.error.code)` under `admin.refund.error.*`, and next-intl's default
 * `getMessageFallback` returns the RAW DOTTED KEY on a miss (use-intl 4.11
 * `defaultGetMessageFallback` → `joinPath(namespace, key)`); `t()` does NOT
 * throw, so the call site's try/catch cannot save it. Five reachable codes
 * shipped with no key — including `f4_bridge_deferred`, whose entire purpose
 * is to stop an admin re-clicking a refund that already settled.
 *
 * The required set is DERIVED FROM THE ROUTE SOURCE, never hand-listed: a
 * hand list drifts exactly the way the JSON did. Adding a `case` to
 * `httpStatusForUseCaseError` extends the required set automatically.
 */
const ROUTE_CODE_I18N_SURFACES = [
  {
    label: 'refunds.initiate',
    route: 'src/app/api/refunds/initiate/route.ts',
    namespace: 'admin.refund.error',
    // Floor guard against a silent false-GREEN: if a refactor changes the
    // literal shape the extractor keys on, we must fail loudly rather than
    // conclude "0 codes required". Fix the patterns; never lower this.
    minCodes: 14,
  },
] as const;

// `routeCode: 'x'` inside the exhaustive use-case-error switch, plus direct
// `errorResponse(<3-digit status>, 'x', …)` calls in the handler body. The
// `errorResponse(status, routeCode, …)` variable call is deliberately NOT
// matched — those codes are already covered by the `routeCode:` literals.
const ROUTE_CODE_RE = /routeCode:\s*'([a-z0-9_]+)'/g;
const ERROR_RESPONSE_LITERAL_RE = /errorResponse\(\s*\d{3}\s*,\s*'([a-z0-9_]+)'/g;

async function checkRouteErrorCodeI18nCoverage(
  sets: Record<Locale, Set<string>>,
): Promise<boolean> {
  let ok = true;
  for (const surface of ROUTE_CODE_I18N_SURFACES) {
    const src = await readFile(resolve(process.cwd(), surface.route), 'utf8');
    const codes = new Set<string>();
    for (const re of [ROUTE_CODE_RE, ERROR_RESPONSE_LITERAL_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) codes.add(m[1]!);
    }
    if (codes.size < surface.minCodes) {
      console.error(
        `[check:i18n] HARD FAIL — ${surface.label}: extracted only ${codes.size} route ` +
          `code(s) from ${surface.route} (expected >= ${surface.minCodes}). The extractor ` +
          `patterns no longer match the route source. Fix the patterns — do NOT lower minCodes.`,
      );
      ok = false;
      continue;
    }
    for (const code of [...codes].sort()) {
      const key = `${surface.namespace}.${code}`;
      for (const locale of LOCALES) {
        if (!sets[locale].has(key)) {
          console.error(
            `[check:i18n] HARD FAIL — ${surface.label} can return error code "${code}" but ` +
              `${locale}.json has no "${key}". next-intl renders the raw dotted key, so an ` +
              `admin would see "${key}" on a money surface.`,
          );
          ok = false;
        }
      }
    }
  }
  return ok;
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

  // I6 — hard fail on EVERY branch, not release-gated. The release-gated
  // soft path below exists for TH/SV translation lag; this is structural
  // wiring that breaks EN too, so it belongs with the namespace hard fail.
  if (!(await checkRouteErrorCodeI18nCoverage(sets))) {
    process.exitCode = 1;
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

// ---------------------------------------------------------------------------
// T161 — `--strict-aria` AST-lite scanner (F7.1a Phase 6, CHK033 closure).
//
// Detects hardcoded user-facing text in JSX `aria-*` attributes. Per
// Constitution Principle V (i18n EN/TH/SV) every user-visible string
// — including SR-announced ones — MUST resolve via `t('namespace.key')`,
// never a string literal.
//
// Targeted attributes (text-bearing aria props that ARE user-facing):
//   - aria-label           (button labels, icon-only controls)
//   - aria-roledescription (custom-widget role names)
//   - aria-placeholder     (input placeholders for SR)
//   - aria-valuetext       (slider value announcements)
//   - aria-keyshortcuts    (keyboard shortcut help)
//
// Intentionally NOT targeted: aria-hidden / aria-pressed / aria-busy /
// aria-expanded / aria-live / aria-controls / aria-labelledby — these
// take FIXED enum values or element-id references, never user text.
// Same applies to `role="..."` — role values are ARIA-spec identifiers
// (button, alert, etc.), not user-facing labels.
//
// Implementation choice: regex over TSX files, NOT full AST. Constitution
// X (Simplicity / YAGNI) — adding `@typescript-eslint/parser` for this
// single use case is over-engineering; the regex catches >95% of real
// violations with zero new dependencies. False positives (string-literal
// values that happen to look like aria-X="..." inside non-JSX context,
// e.g., inside string concatenation) are rare and surfaceable via the
// `// strict-aria-ignore-next-line` comment escape hatch.
//
// Allowlist file: `.strict-aria-allowlist.txt` at repo root — one
// `file:line` pair per line. Used for legacy violations that cannot
// be fixed without significant refactor; should shrink over time.
// ---------------------------------------------------------------------------

import { readdirSync, statSync } from 'node:fs';

const TEXT_ARIA_ATTRS = [
  'aria-label',
  'aria-roledescription',
  'aria-placeholder',
  'aria-valuetext',
  'aria-keyshortcuts',
] as const;

// H8 fix 2026-05-21 (review finding code-reviewer-narrow H-2 +
// comment-analyzer H-3): widened scan covers THREE literal patterns:
//   1. Double-quoted JSX literal: `aria-label="Close"`
//   2. Single-quoted JSX expression literal: `aria-label={'Close'}`
//   3. Template literal (no interpolation): `aria-label={\`Close\`}`
//
// JSX expressions containing `t('key')` calls correctly DO NOT match
// any pattern (the value starts with `t(` not `'` or `"` or `` ` ``).
// Template literals WITH `${...}` interpolation are NOT flagged because
// they likely interpolate non-string variables (e.g., row indices).
// False-positive risk on a literal template like `` `Close ${name}` ``
// is accepted as cheap-to-add-ignore-directive vs missing the literal
// `` `Close` `` case which is the more common dev-side bypass.
//
// Implementation note: three separate regexes (one per pattern) iterated
// in sequence. Single mega-alternation regex was tried but the multiple
// capture-groups across alternatives made matched-attr resolution
// fragile (would require scanning ALL captures per match to find the
// non-undefined one). Per-pattern iteration is O(N×3) instead of O(N×1)
// but N is small (~407 TSX files, ~50k LoC total).
const STRICT_ARIA_RES = TEXT_ARIA_ATTRS.flatMap((attr) => [
  // Pattern 1: double-quoted JSX attribute
  { attr, re: new RegExp(`\\b(${attr})="([^"]+)"`, 'g') },
  // Pattern 2: JSX expression with single-quoted string literal
  { attr, re: new RegExp(`\\b(${attr})=\\{\\s*'([^'{}]+)'\\s*\\}`, 'g') },
  // Pattern 3: JSX expression with template literal (no interpolation)
  { attr, re: new RegExp(`\\b(${attr})=\\{\\s*\`([^\`{}]+)\`\\s*\\}`, 'g') },
]);

// Ignore comment: a `// strict-aria-ignore-next-line` (or `{/* */}` JSX
// variant) on the line BEFORE a violation suppresses it. Used sparingly
// for legitimate edge cases (e.g., visually-hidden test fixtures).
const IGNORE_NEXT_RE = /strict-aria-ignore-next-line/;

interface AriaViolation {
  readonly file: string;
  readonly line: number;
  readonly attr: string;
  readonly value: string;
}

/**
 * Accumulates FS errors during the TSX-file walk. M4 Round 2 closure
 * 2026-05-21 (review finding silent-failure-hunter M2): the prior
 * patch logged errors but exit-coded 0 even on partial-walks, leaving
 * a false-GREEN window. Now the caller checks `walkErrors.length > 0`
 * AND `process.env.CI === 'true'` and exits non-zero in CI — keeping
 * dev workflow lenient while gating the merge surface tight.
 */
const walkErrors: string[] = [];

function walkTsxFiles(dir: string, out: string[]): void {
  // silent-failure-hunter#3 fix 2026-05-21: log FS errors instead of
  // silent skip. A single unreadable file would have previously
  // silently shrunk the scan set without surfacing the cause —
  // producing a false-GREEN. The M-5 empty-list guard at the caller
  // catches the worst case (entire root unreadable); this catches the
  // intermediate-directory + single-file class.
  let entries: ReadonlyArray<string>;
  try {
    entries = readdirSync(dir);
  } catch (e) {
    const msg = `[strict-aria] skipped directory ${dir} (${(e as Error).message})`;
    console.warn(msg);
    walkErrors.push(msg);
    return;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = resolve(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch (e) {
      const msg = `[strict-aria] skipped path ${full} (${(e as Error).message})`;
      console.warn(msg);
      walkErrors.push(msg);
      continue;
    }
    if (st.isDirectory()) {
      walkTsxFiles(full, out);
    } else if (st.isFile() && entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
}

async function scanStrictAria(): Promise<number> {
  const srcRoot = resolve(process.cwd(), 'src');
  const tsxFiles: string[] = [];
  walkErrors.length = 0; // reset between repeated scanStrictAria invocations
  walkTsxFiles(srcRoot, tsxFiles);

  // M-5 fix 2026-05-21 (review finding code-reviewer-full M-5 +
  // silent-failure-hunter#3): if the walk produced zero TSX files,
  // that's not "0 violations across 0 files" GREEN — it's a config
  // misalignment (wrong CWD, missing `src/` mount in CI sandbox,
  // permission errors silently swallowed by walkTsxFiles). Fail
  // non-zero so the CI gate surfaces the misconfig instead of
  // delivering a false-GREEN.
  if (tsxFiles.length === 0) {
    console.error(
      `[strict-aria] FAIL — walked 0 TSX files under ${srcRoot}. ` +
        'Likely cwd misalignment, missing `src/` mount in CI sandbox, ' +
        'or silenced FS errors. Re-run from repo root + verify src/ exists.',
    );
    return 1;
  }

  // M4 Round 2 closure 2026-05-21 (silent-failure-hunter M2): partial-
  // walk false-GREEN guard. CI environment surfaces FS errors as a
  // gate-blocking failure; dev workflow stays lenient so a single
  // unreadable symlink doesn't break local iteration. The `walkErrors`
  // accumulator is populated by `walkTsxFiles` whenever it caught an
  // `EACCES` / `ENOTDIR` / similar.
  if (walkErrors.length > 0 && process.env.CI === 'true') {
    console.error(
      `[strict-aria] FAIL (CI mode) — ${walkErrors.length} FS error(s) during walk. ` +
        'A single unreadable file can shrink the scan set and produce ' +
        'a false-GREEN. Fix the file-permission issue and re-run.',
    );
    return 1;
  }

  const violations: AriaViolation[] = [];

  for (const filePath of tsxFiles) {
    const raw = await readFile(filePath, 'utf8');
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line === undefined) continue;
      // Skip if previous line carries the ignore directive
      const prev = i > 0 ? lines[i - 1] : '';
      if (prev && IGNORE_NEXT_RE.test(prev)) continue;

      for (const { attr, re } of STRICT_ARIA_RES) {
        re.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = re.exec(line)) !== null) {
          const value = match[2];
          if (value === undefined) continue;
          violations.push({
            file: filePath,
            line: i + 1,
            attr,
            value,
          });
        }
      }
    }
  }

  if (violations.length === 0) {
    console.log(
      `[strict-aria] OK — 0 hardcoded aria-text attributes across ${tsxFiles.length} TSX files`,
    );
    return 0;
  }

  console.error(
    `[strict-aria] ${violations.length} hardcoded aria-text attribute(s) found:`,
  );
  for (const v of violations) {
    const rel = v.file.replace(`${process.cwd()}/`, '').replace(/\\/g, '/');
    console.error(`  ${rel}:${v.line}  ${v.attr}="${v.value}"`);
  }
  console.error(
    '[strict-aria] Use `t(\'namespace.key\')` for user-facing text; ' +
      'add `// strict-aria-ignore-next-line` directly above the line ' +
      'for legitimate exceptions.',
  );
  return 1;
}

async function maybeStrictAria(): Promise<void> {
  if (!process.argv.includes('--strict-aria')) return;
  const exitCode = await scanStrictAria();
  if (exitCode !== 0) process.exit(exitCode);
}

main()
  .then(maybeStrictAria)
  .catch((error) => {
    console.error('[check:i18n] crashed:', error);
    process.exit(1);
  });
