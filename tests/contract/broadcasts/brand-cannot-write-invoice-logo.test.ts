/**
 * F119 T010 — FR-041b: no route reachable with `settings.broadcasts` alone
 * can write `tenant_invoice_settings.logo_blob_key` (the panel's confirmed
 * #7 blocker: letting the Brand page write the invoice logo would move a
 * super-admin-only, tax-document control down to the admin tier).
 *
 * The only code that can write the logo lives in `src/modules/invoicing`
 * (`uploadTenantLogo`, `updateTenantInvoiceSettings`,
 * `drizzleTenantSettingsRepo.upsert`). So the check is a reachability scan:
 * from every `src/app/api/**` route (and every staff page) gated on
 * `settings.broadcasts`, walk the import graph across the broadcasts side
 * (`src/app`, `src/lib`, `src/components`, `src/config`, `src/i18n`,
 * `src/modules/broadcasts` — every other module is a boundary) and assert,
 * on comment-stripped source, that
 *   (a) every value import from `@/modules/invoicing` (barrel or deep) is in
 *       the READ-ONLY allow-list,
 *   (b) no reachable file calls a logo WRITER (`uploadTenantLogo`,
 *       `updateTenantInvoiceSettings`, `drizzleTenantSettingsRepo.upsert`…),
 *   (c) no reachable file mentions `logoBlobKey` / `logo_blob_key` at all.
 *
 * The positive controls feed the same scanner synthetic graphs and assert the
 * scan REPORTS them — a scanner that cannot tell "nothing found" from "not
 * looking" is not a check. The runtime arm (a PATCH body carrying a logo key
 * is refused 400) is in `admin-eblast-brand.test.ts`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolvePath(__dirname, '..', '..', '..');
const SRC = join(ROOT, 'src');

/**
 * Invoicing exports the broadcasts side may VALUE-import.
 * `drizzleTenantSettingsRepo` is an object that also carries the writer
 * (`upsert`), so it is allowed only together with the write-verb rule below:
 * `resolveTenantDisplayName` reads `getForIssue` through it and nothing may
 * call its writers. `systemClock` is the shared clock the membership-access
 * bridge reuses.
 */
const INVOICING_READ_ONLY_ALLOWLIST: ReadonlySet<string> = new Set([
  'getTenantLogoPublicUrl',
  'drizzleTenantSettingsRepo',
  'systemClock',
]);

/** Every way the invoice logo can be written, as it would appear in a caller. */
const LOGO_WRITE_VERBS: readonly RegExp[] = [
  /\buploadTenantLogo\s*\(/,
  /\bmakeUploadTenantLogoDeps\s*\(/,
  /\bupdateTenantInvoiceSettings\s*\(/,
  /\bmakeUpdateTenantInvoiceSettingsDeps\s*\(/,
  /drizzleTenantSettingsRepo\s*\.\s*(upsert|update|clearLogo|setLogo)\b/,
];

/** The broadcasts side: the walk never enters another module's internals. */
const WALK_ROOTS = ['app', 'lib', 'components', 'config', 'i18n', join('modules', 'broadcasts')].map(
  (p) => join(SRC, p),
);

interface Fs {
  readonly readFile: (abs: string) => string | null;
  readonly exists: (abs: string) => boolean;
}

const realFs: Fs = {
  readFile: (abs) => (existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, 'utf8') : null),
  exists: (abs) => existsSync(abs),
};

const IMPORT_RE =
  /import\s+(type\s+)?(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*(?:\*\s+as\s+[\w$]+)?\s*from\s*['"]([^'"]+)['"]/g;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

function listFiles(root: string, out: string[] = []): string[] {
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    if (statSync(full).isDirectory()) listFiles(full, out);
    else if (/\.(ts|tsx)$/.test(full) && !/\.test\./.test(full)) out.push(full);
  }
  return out;
}

function resolveImport(fromFile: string, spec: string, fs: Fs): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = resolvePath(dirname(fromFile), spec);
  else return null; // node_modules
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (fs.exists(cand) && (cand.endsWith('.ts') || cand.endsWith('.tsx'))) return cand;
  }
  return null;
}

export interface LogoWriteFinding {
  readonly file: string;
  readonly reason: string;
}

/** Walk the graph from `roots`; report every way a logo write could be reached. */
export function scanLogoWritePaths(roots: readonly string[], fs: Fs): LogoWriteFinding[] {
  const findings: LogoWriteFinding[] = [];
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const raw = fs.readFile(file);
    if (raw === null) continue;
    const src = stripComments(raw);
    if (/logoBlobKey|logo_blob_key/.test(src)) {
      findings.push({ file, reason: 'mentions the invoice logo column' });
    }
    for (const verb of LOGO_WRITE_VERBS) {
      if (verb.test(src)) findings.push({ file, reason: `calls a logo writer (${verb.source})` });
    }
    for (const m of src.matchAll(IMPORT_RE)) {
      const [, typeOnly, defaultName, named, spec] = m;
      if (spec === undefined) continue;
      if (spec === '@/modules/invoicing' || spec.startsWith('@/modules/invoicing/')) {
        if (typeOnly) continue;
        const names = (named ?? '')
          .split(',')
          .map((n) => n.trim())
          .filter((n) => n.length > 0 && !n.startsWith('type '))
          .map((n) => n.split(/\s+as\s+/)[0]!.trim());
        if (defaultName) names.push(defaultName);
        for (const n of names) {
          if (!INVOICING_READ_ONLY_ALLOWLIST.has(n)) {
            findings.push({ file, reason: `imports non-read-only invoicing export \`${n}\` from ${spec}` });
          }
        }
        continue;
      }
      const target = resolveImport(file, spec, fs);
      if (target === null) continue;
      // Only the broadcasts side is walked; every other module is a boundary
      // reached through its own barrel and is not this rule's surface.
      if (!WALK_ROOTS.some((r) => target.startsWith(r))) continue;
      stack.push(target);
    }
  }
  return findings;
}

function settingsBroadcastsEntryPoints(): string[] {
  const app = listFiles(join(SRC, 'app'));
  return app.filter((f) => /['"]settings\.broadcasts['"]/.test(readFileSync(f, 'utf8')));
}

describe('FR-041b — no settings.broadcasts-reachable route can write the invoice logo', () => {
  it('there is at least one settings.broadcasts entry point to scan (positive control on discovery)', () => {
    const roots = settingsBroadcastsEntryPoints();
    expect(roots.length).toBeGreaterThanOrEqual(2);
    expect(roots.some((r) => r.includes(join('api', 'admin', 'broadcasts', 'brand', 'route.ts')))).toBe(true);
  });

  it('every settings.broadcasts-reachable route leaves logo_blob_key unchanged: no write path is reachable', () => {
    const findings = scanLogoWritePaths(settingsBroadcastsEntryPoints(), realFs);
    expect(findings.map((f) => `${f.file.slice(ROOT.length + 1)}: ${f.reason}`)).toEqual([]);
  });

  it('positive control: a reachable file importing a writer from the invoicing barrel is reported (comments do not count)', () => {
    const fake: Record<string, string> = {
      [join(SRC, 'app', 'api', 'x', 'route.ts')]: `import { helper } from '@/lib/x-deps';\nexport const GET = helper;`,
      [join(SRC, 'lib', 'x-deps.ts')]:
        `// a comment mentioning logoBlobKey must NOT count\n` +
        `import { updateTenantInvoiceSettings, getTenantLogoPublicUrl } from '@/modules/invoicing';\n` +
        `export const helper = () => [updateTenantInvoiceSettings, getTenantLogoPublicUrl];`,
    };
    const fs: Fs = { readFile: (p) => fake[p] ?? null, exists: (p) => p in fake };
    const findings = scanLogoWritePaths([join(SRC, 'app', 'api', 'x', 'route.ts')], fs);
    expect(findings).toEqual([
      {
        file: join(SRC, 'lib', 'x-deps.ts'),
        reason: 'imports non-read-only invoicing export `updateTenantInvoiceSettings` from @/modules/invoicing',
      },
    ]);
  });

  it('positive control: a write-verb call on the settings repo, or a mention of the column, is reported', () => {
    const fake: Record<string, string> = {
      [join(SRC, 'app', 'api', 'y', 'route.ts')]:
        `import { drizzleTenantSettingsRepo } from '@/modules/invoicing';\n` +
        `export const PATCH = () => drizzleTenantSettingsRepo.upsert({ logoBlobKey: 'k' });`,
    };
    const fs: Fs = { readFile: (p) => fake[p] ?? null, exists: (p) => p in fake };
    const findings = scanLogoWritePaths([join(SRC, 'app', 'api', 'y', 'route.ts')], fs);
    expect(findings.map((f) => f.reason).sort()).toEqual([
      `calls a logo writer (${LOGO_WRITE_VERBS[4]!.source})`,
      'mentions the invoice logo column',
    ]);
  });
});
