/**
 * Post-ship R6 C6 — Negative-coverage test for `plan_cross_tenant_probe`.
 *
 * F2 spec defers the actual emission of this `high`-severity audit
 * event to F13 (Admin Dashboard + Directory + Timeline + Audit Viewer
 * per `docs/phases-plan.md:158`). The event has a payload schema,
 * severity entry, and adapter summarizer in F2 Domain + Infrastructure
 * — but no F2 use-case is supposed to emit it. F13's periodic
 * correlation scanner will read `plan_not_found` rows offline and
 * escalate to `plan_cross_tenant_probe` when a cross-tenant match is
 * detected.
 *
 * This test guards against an accidental F2 emitter that would conflict
 * with F13's correlation pipeline (e.g. a developer wires the
 * request-path probe directly instead of leaving it to F13). When F13
 * ships, update this assertion to allow the F13-owned emitter (or
 * move the test into the F13 module).
 *
 * Pattern: grep-based source scan over `src/modules/plans/**` and
 * `src/app/api/plans/**`. We exclude the declaration sites
 * (`audit-event.ts` enum + payload schema + discriminated union;
 * `plan-audit-adapter.ts` summarizer) since those are
 * infrastructure-ready scaffolding, not emitters.
 *
 * Why grep-based instead of behavioural: there is no behavioural code
 * path to assert against today — only ABSENCE of emission. A
 * behavioural test would falsely-pass simply because no emitter is
 * wired. Grep proves the assertion explicitly.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

/** Files where the literal string `'plan_cross_tenant_probe'` is OK
 *  (declaration / schema / summarizer scaffolding — not an emit site). */
const DECLARATION_ALLOWLIST = [
  join(REPO_ROOT, 'src', 'modules', 'plans', 'domain', 'audit-event.ts'),
  join(
    REPO_ROOT,
    'src',
    'modules',
    'plans',
    'infrastructure',
    'audit',
    'plan-audit-adapter.ts',
  ),
];

/** Recursive `find` of `.ts` / `.tsx` files under a directory. */
function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: ReadonlyArray<string>;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      out.push(...walk(full));
    } else if (
      stat.isFile() &&
      (entry.endsWith('.ts') || entry.endsWith('.tsx'))
    ) {
      out.push(full);
    }
  }
  return out;
}

describe('post-ship R6 C6 — `plan_cross_tenant_probe` has no F2 emitter', () => {
  it('no production file under src/modules/plans/** or src/app/api/plans/** emits the event (declarations + adapter summarizer excluded)', () => {
    const scanRoots = [
      join(REPO_ROOT, 'src', 'modules', 'plans'),
      join(REPO_ROOT, 'src', 'app', 'api', 'plans'),
    ];

    const offenders: ReadonlyArray<{ file: string; line: number; snippet: string }> =
      scanRoots
        .flatMap((root) => walk(root))
        .filter((file) => !DECLARATION_ALLOWLIST.includes(file))
        .flatMap((file) => {
          const text = readFileSync(file, 'utf8');
          // Match the literal string used as an event_type or in
          // an emitter context. Comments + JSDoc references are
          // allowed (they may explain the deferral); only flag
          // active code occurrences. Heuristic: flag any line that
          // includes the literal AND is not inside a // comment.
          const lines = text.split(/\r?\n/);
          const hits: Array<{ file: string; line: number; snippet: string }> = [];
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i] ?? '';
            if (!line.includes('plan_cross_tenant_probe')) continue;
            // Skip lines that are purely comments (// or * or whole-line
            // block-comment continuations).
            const trimmed = line.trimStart();
            if (
              trimmed.startsWith('//') ||
              trimmed.startsWith('*') ||
              trimmed.startsWith('/*')
            ) {
              continue;
            }
            hits.push({ file, line: i + 1, snippet: line.trim() });
          }
          return hits;
        });

    if (offenders.length > 0) {
      const formatted = offenders
        .map(
          (o) =>
            `  - ${o.file.replace(REPO_ROOT, '')}:${o.line} → ${o.snippet}`,
        )
        .join('\n');
      throw new Error(
        `Found ${offenders.length} F2 production code path(s) referencing 'plan_cross_tenant_probe' outside the declaration allowlist.\n` +
          `F2 spec defers emission of this event to F13 — see test file header.\n` +
          `When F13 ships, update DECLARATION_ALLOWLIST or move this test to F13.\n` +
          `Offenders:\n${formatted}`,
      );
    }
    expect(offenders).toHaveLength(0);
  });
});
