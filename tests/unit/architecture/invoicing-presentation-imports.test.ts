/**
 * Architecture test — F4 invoicing module barrel boundary for Presentation
 * (065 review follow-up, item 6 — enforcement-gap closure).
 *
 * **Why a source-scan test (and not an ESLint rule):** identical rationale
 * to tests/unit/architecture/broadcasts-barrel.test.ts (R1.3-S2) — the
 * `no-restricted-imports` barrel-guard block in eslint.config.mjs is
 * silently SHADOWED for `src/**` by the F6 events branded-types block
 * (flat-config last-wins), so NO lint rule fires on a presentation file
 * deep-importing invoicing internals. The 064 wave-4 S19 codes-leaf import
 * in event-fee-form.tsx made the gap live: a deliberate, documented deep
 * import that NOTHING machine-checks — the next (accidental) one would land
 * invisibly. This scan mirrors the broadcasts test's mechanics exactly:
 *
 *   1. ALL current deep imports must be in `KNOWN_ALLOWLIST` — any NEW
 *      deep import fails the test with a refactor hint.
 *   2. EVERY allowlist entry must still exist in source — a refactor that
 *      removes a deep import must also remove its entry (no rot).
 *
 * **The two allowlisted exception classes (audited 2026-06-11):**
 *
 *   (a) APPLICATION leaf — `issue-event-invoice-as-paid-codes` ONLY.
 *       Client-bundle rationale (wave-4 S19): the invoicing BARREL's runtime
 *       graph is server-only (pino logger, node crypto via the use-cases),
 *       so the client form must import the pure-constants codes leaf
 *       directly; the leaf has a type-only dependency on the use-case. Any
 *       OTHER application/domain deep import from presentation is a hard
 *       Constitution III violation with no standing exception.
 *
 *   (b) INFRASTRUCTURE composition roots — server pages/routes building
 *       repo/adapter instances directly (the documented F4/F5 escape-hatch
 *       pattern; each site carries its own rationale comment and is a
 *       Phase-9/10 consolidation candidate, e.g. the CN-repo read on the
 *       portal invoice detail page). These are allowlisted EXPLICITLY (not
 *       scoped out of the scan) so the backlog stays visible and growth is
 *       a deliberate, reviewed decision — broadcasts-test precedent.
 *
 * Format: `file::importPath` content keys (R3.5 M-4 drift-resistant form).
 */
import { describe, it, expect } from 'vitest';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';

const PROJECT_ROOT = join(__dirname, '..', '..', '..');

/** Presentation surfaces that MUST go through the invoicing barrel. */
const SCAN_ROOTS = [
  join(PROJECT_ROOT, 'src', 'app'),
  join(PROJECT_ROOT, 'src', 'components'),
] as const;

/** Forbidden deep-import patterns (canonical aliased + relative forms). */
const FORBIDDEN_PATH_PATTERNS: readonly RegExp[] = [
  /from\s+['"]@\/modules\/invoicing\/(domain|application|infrastructure)\//,
  /from\s+['"]\.{1,2}(?:\/\.\.)*\/modules\/invoicing\/(domain|application|infrastructure)\//,
] as const;

/**
 * Allowlist of CURRENT deep imports (captured 2026-06-11, 065 item 6).
 * Total: 11 entries — 1 application leaf + 10 infrastructure
 * composition-root sites across 8 consumer files. src/components/** is
 * CLEAN (zero entries) — keep it that way.
 */
const KNOWN_ALLOWLIST: ReadonlySet<string> = new Set([
  // --- (a) APPLICATION leaf — the ONLY sanctioned non-infra deep import.
  // Client-bundle rationale (wave-4 S19): pure-constants error-code leaf
  // consumed by the client form; the barrel's runtime graph is server-only.
  "src/app/(staff)/admin/invoices/new/_components/event-fee-form.tsx::@/modules/invoicing/application/use-cases/issue-event-invoice-as-paid-codes",
  // --- (b) INFRASTRUCTURE composition roots (documented escape-hatch;
  // each site carries its own rationale comment + consolidation note).
  // Admin invoice detail — tenant settings + CN list + outbox adapter reads.
  "src/app/(staff)/admin/invoices/[invoiceId]/page.tsx::@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo",
  "src/app/(staff)/admin/invoices/[invoiceId]/page.tsx::@/modules/invoicing/infrastructure/repos/drizzle-credit-note-repo",
  "src/app/(staff)/admin/invoices/[invoiceId]/page.tsx::@/modules/invoicing/infrastructure/adapters/resend-email-outbox-adapter",
  // Admin credit-note detail — CN repo read.
  "src/app/(staff)/admin/credit-notes/[creditNoteId]/page.tsx::@/modules/invoicing/infrastructure/repos/drizzle-credit-note-repo",
  // Admin invoicing settings page + its API route — tenant settings repo.
  "src/app/(staff)/admin/settings/invoicing/page.tsx::@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo",
  "src/app/api/tenant-invoice-settings/route.ts::@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo",
  // Portal invoice detail — CN list read (RLS-scoped, post-ownership-check).
  "src/app/(member)/portal/invoices/[invoiceId]/page.tsx::@/modules/invoicing/infrastructure/repos/drizzle-credit-note-repo",
  // Cron: event-buyer PII redaction — audit + blob adapters.
  "src/app/api/cron/invoicing/redact-expired-event-buyers/route.ts::@/modules/invoicing/infrastructure/adapters/audit-adapter",
  "src/app/api/cron/invoicing/redact-expired-event-buyers/route.ts::@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter",
  // Cron: receipt-PDF reconcile — direct schema read for the sweep query.
  "src/app/api/internal/cron/receipt-pdf-reconcile/route.ts::@/modules/invoicing/infrastructure/db/schema-invoices",
]);

async function* walkTs(dir: string): AsyncGenerator<string> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let s;
    try {
      s = await stat(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      yield* walkTs(full);
    } else if (
      s.isFile() &&
      (entry.endsWith('.ts') || entry.endsWith('.tsx')) &&
      !entry.endsWith('.d.ts')
    ) {
      yield full;
    }
  }
}

interface DeepImport {
  readonly key: string; // `${file}::${importPath}`
  readonly text: string;
}

/**
 * Extract the deep-import PATH from a violating line (drift-resistant
 * content key — broadcasts R3.5 M-4). Single-line scanner: multi-line
 * imports still match on their `from '...'` line (broadcasts R4.3 M-12
 * known limitation carries over).
 */
function extractImportPath(line: string): string | null {
  const match = line.match(/from\s+['"]([^'"]+)['"]/);
  return match?.[1] ?? null;
}

async function findDeepImports(): Promise<DeepImport[]> {
  const offenders: DeepImport[] = [];
  for (const root of SCAN_ROOTS) {
    for await (const file of walkTs(root)) {
      const source = await readFile(file, 'utf8');
      const lines = source.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (FORBIDDEN_PATH_PATTERNS.some((re) => re.test(line))) {
          const repoRel = file
            .replace(PROJECT_ROOT + sep, '')
            .replaceAll(sep, '/');
          const importPath = extractImportPath(line) ?? `<line ${i + 1}>`;
          offenders.push({
            key: `${repoRel}::${importPath}`,
            text: line.trim(),
          });
        }
      }
    }
  }
  return offenders;
}

describe('invoicing module barrel — presentation deep-import guard (065 item 6)', () => {
  it('forbids NEW deep imports from src/app/** + src/components/** into invoicing internals', async () => {
    const offenders = await findDeepImports();
    const offenderKeys = new Set(offenders.map((o) => o.key));

    // (1) NEW deep imports (in source but not allowlisted).
    const newViolations = offenders.filter((o) => !KNOWN_ALLOWLIST.has(o.key));
    if (newViolations.length > 0) {
      const formatted = newViolations
        .map((o) => `  ${o.key} → ${o.text}`)
        .join('\n');
      throw new Error(
        `Constitution Principle III violation — NEW deep import(s) into invoicing internals:\n${formatted}\n\n` +
          'Use the public barrel `@/modules/invoicing` instead. If the ' +
          'needed symbol is missing from the barrel, ADD IT TO ' +
          '`src/modules/invoicing/index.ts` rather than importing the deep ' +
          'path. The ONLY standing exceptions are (a) the client-bundle ' +
          'codes leaf and (b) documented server composition-root ' +
          'infrastructure sites — if your import genuinely matches one of ' +
          'those classes, add its `${file}::${importPath}` key to ' +
          'KNOWN_ALLOWLIST with a one-line rationale comment. Do not ' +
          'silently allow drift.',
      );
    }

    // (2) Stale allowlist entries (refactored imports left dangling).
    const staleAllowlist: string[] = [];
    for (const key of KNOWN_ALLOWLIST) {
      if (!offenderKeys.has(key)) {
        staleAllowlist.push(key);
      }
    }
    if (staleAllowlist.length > 0) {
      throw new Error(
        `Stale KNOWN_ALLOWLIST entries (refactored deep imports left dangling):\n${staleAllowlist
          .map((k) => `  ${k}`)
          .join('\n')}\n\n` +
          'Remove these entries from KNOWN_ALLOWLIST in this test file. ' +
          'A stale allowlist defeats the architecture-test defence.',
      );
    }

    // Both checks passed — current source = allowlist exactly.
    expect(offenders.length).toBe(KNOWN_ALLOWLIST.size);
  });

  it('the application/domain layers carry exactly ONE sanctioned deep import (the codes leaf)', async () => {
    // Belt-and-braces beyond the exact-set check above: even an ALLOWLISTED
    // future edit cannot quietly grow the application/domain exception class
    // past the single client-bundle leaf without flipping this count.
    const offenders = await findDeepImports();
    const nonInfra = offenders.filter(
      (o) => !o.key.includes('/modules/invoicing/infrastructure/'),
    );
    expect(nonInfra.map((o) => o.key)).toEqual([
      "src/app/(staff)/admin/invoices/new/_components/event-fee-form.tsx::@/modules/invoicing/application/use-cases/issue-event-invoice-as-paid-codes",
    ]);
  });
});
