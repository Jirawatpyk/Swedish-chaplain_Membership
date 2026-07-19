/**
 * Architecture test — settlement-primitive ADOPTION scan (money-remediation Task 12a).
 *
 * ## What this test proves, and what it very deliberately does NOT
 *
 * **It proves adoption, not correctness.** It counts how many transactions in
 * the payments Application layer are still opened with a raw
 * `paymentsRepo.withTx(...)` instead of `runTxDecided(...)`, and pins that
 * count. That is all.
 *
 * It does **not** verify that any given transaction takes the right exit. It
 * cannot tell a correct `return err(...)` (nothing was written yet — refusing
 * before the first write is fine) from finding F-1 (money-side state written,
 * then refused, and `withTx` commits the write it was refusing). Every entry in
 * `KNOWN_RAW_WITHTX` below is **unaudited**: listed because it exists, not
 * because anyone has checked it. A green run here means "the inventory is
 * accurate", never "these transactions are safe".
 *
 * Do not cite this file as evidence that a settlement path is correct, and do
 * not rename it to anything that implies it validates transaction semantics.
 *
 * ## Why the inventory exists
 *
 * `runTxDecided` / `commitTx` / `rollbackTx`
 * (`src/modules/payments/application/settlement/tx-decision.ts`, Task 2) make a
 * silent-commit-on-refusal unrepresentable — but only for callers that opt in,
 * and adoption is opt-in. Exactly **one** site has opted in so far
 * (`sweep-stale-pending-refunds.ts:467`). The rest are inventoried here so that:
 *
 *   - adding a **new** raw `withTx` call fails this test, naming the file;
 *   - **converting** one fails it too, forcing the baseline down in the same
 *     diff — which is what makes a conversion self-documenting to a reviewer;
 *   - the inventory's **size** is asserted against a pinned total, so the
 *     problem cannot be shrunk by editing the reasons instead of the code.
 *
 * The direction matters: this baseline was written **before** the first
 * conversion landed. Written afterwards it would have blessed the survivors as
 * house style.
 *
 * ## Why a vitest test rather than a `pnpm check:*` script
 *
 * `.husky/pre-push` runs `vitest run tests/contract/ tests/unit/architecture/`,
 * so a file dropped here is enforced from the first push with zero wiring.
 * `.github/workflows/` holds only three narrow workflows (multi-tenant
 * readiness, Neon preview cleanup, template-seed drift) — there is **no**
 * general lint/typecheck/`check:*` CI job in this repo. A new `check:settlement`
 * script wired nowhere would never execute. Same reasoning as the sibling
 * `application-layer-imports.test.ts`, whose baseline shape this follows.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const SCAN_ROOT = join(PROJECT_ROOT, 'src', 'modules', 'payments', 'application');

/**
 * Files allowed to call `.withTx(` without going through `runTxDecided`.
 *
 * Only the primitive itself: `runTxDecided` is *implemented* on top of
 * `runner.withTx`, so requiring it to call itself would be circular.
 */
const EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    'settlement/tx-decision.ts',
    'the primitive itself — runTxDecided is implemented on top of runner.withTx',
  ],
]);

/**
 * Transactions still opened with a raw `paymentsRepo.withTx(...)`, by file.
 *
 * **Every entry is UNAUDITED** (see the header). The reason column records what
 * the transaction is for, so a reviewer can judge conversion priority — it is
 * not a safety finding. Counts are per file rather than per line because the
 * call sites are lexically near-identical and line numbers churn on every edit
 * to the file (this repo has shipped source-grep tests that broke on refactor).
 *
 * To convert a site: adopt `runTxDecided` and decrement the count here in the
 * same commit. When a file reaches 0, delete its entry.
 */
const KNOWN_RAW_WITHTX: ReadonlyMap<string, { readonly count: number; readonly reason: string }> =
  new Map([
    [
      'use-cases/confirm-payment.ts',
      {
        count: 6,
        reason:
          'Phase-A capture/settle tx + five Phase-B follow-ups (markProcessed, late-charge reconcile). Phase A is finding F-1 itself — Task 4 converts it.',
      },
    ],
    [
      'use-cases/issue-refund.ts',
      {
        count: 5,
        reason:
          'refund preflight, prepare, persist, finalise and re-read transactions — the F-3/F-4 surface Tasks 6 and 7 have just edited.',
      },
    ],
    [
      'use-cases/process-webhook-event.ts',
      {
        count: 3,
        reason:
          'processor_events insert + two dispatch-tail transactions folding markProcessed into the sub-use-case tx.',
      },
    ],
    [
      'use-cases/cancel-payment.ts',
      { count: 1, reason: 'Phase-B cancel: re-lock FOR UPDATE, re-check state, transition.' },
    ],
    [
      'use-cases/fail-payment.ts',
      { count: 1, reason: 'mark payment failed + fold markProcessed into the same tx.' },
    ],
    [
      'use-cases/handle-cancel-event.ts',
      { count: 1, reason: 'webhook-driven cancel + markProcessed in one tx.' },
    ],
    [
      'use-cases/initiate-payment.ts',
      { count: 1, reason: 'steps 5-6: nextAttemptSeq, resume-or-insert, createIntent, audit.' },
    ],
    [
      'use-cases/process-charge-refunded.ts',
      { count: 1, reason: 'out-of-band refund recording + markProcessed atomically.' },
    ],
    [
      'use-cases/process-refund-updated.ts',
      { count: 1, reason: 'single tx folding every refund-updated outcome branch.' },
    ],
    [
      'use-cases/resolve-failed-auto-refund.ts',
      { count: 1, reason: 'operator-driven resolution of a failed auto-refund row.' },
    ],
    [
      'use-cases/sweep-stale-pending-refunds.ts',
      {
        count: 1,
        reason:
          'the stale-row list-read only; the per-row finalise tx at :467 is the ONE site already on runTxDecided.',
      },
    ],
  ]);

/**
 * Pinned independently of `KNOWN_RAW_WITHTX` so that trimming the inventory
 * without converting code fails instead of quietly lowering the bar.
 */
const RAW_WITHTX_TOTAL = 22;

/**
 * `commitTxWithRefusal` commits *and* returns a refusal. That is legitimate for
 * forensic/audit writes and is finding F-1 for anything money-side, and the
 * function is unfenced — it accepts any `T`. Zero production callers today;
 * inventory each one as it arrives so reaching for it is a reviewable choice
 * rather than a way around `commitTx`'s `Err` ban.
 */
const KNOWN_COMMIT_WITH_REFUSAL: ReadonlyMap<string, { readonly count: number; readonly reason: string }> =
  new Map([]);

function listScannedFiles(): string[] {
  const out: string[] = [];
  walk(SCAN_ROOT, out);
  return out.sort();
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) {
      out.push(full);
    }
  }
}

function relPath(file: string): string {
  return relative(SCAN_ROOT, file).split(sep).join('/');
}

/**
 * Strips comments, then counts matches of `pattern`.
 *
 * Comment stripping matters because `tx-decision.ts`'s docstring contains a
 * worked `paymentsRepo.withTx(...)` example — a code sample is not a call site.
 * A block-comment state machine handles JSDoc (including its ` * ` continuation
 * lines, which sit inside the block by construction); trailing `//` is cut from
 * its first occurrence. Both err toward over-counting on exotic input, which
 * fails loudly rather than silently passing.
 */
function countOutsideComments(content: string, pattern: RegExp): number {
  let count = 0;
  let inBlock = false;

  for (const rawLine of content.split('\n')) {
    let line = rawLine;

    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) continue;
      line = line.slice(end + 2);
      inBlock = false;
    }

    const blockStart = line.indexOf('/*');
    if (blockStart !== -1 && line.indexOf('*/', blockStart) === -1) {
      inBlock = true;
      line = line.slice(0, blockStart);
    }

    const lineComment = line.indexOf('//');
    if (lineComment !== -1) line = line.slice(0, lineComment);

    count += line.match(pattern)?.length ?? 0;
  }

  return count;
}

/** Any `.withTx(` call. A site converted to `runTxDecided` passes the repo as an
 *  argument and therefore contains no `.withTx(` token at all — so every match
 *  under the scanned tree is, by construction, an unconverted site. */
const RAW_WITHTX = /\.withTx\s*\(/g;
const COMMIT_WITH_REFUSAL = /\bcommitTxWithRefusal\s*\(/g;

function scan(pattern: RegExp): Map<string, number> {
  const found = new Map<string, number>();
  for (const file of listScannedFiles()) {
    const rel = relPath(file);
    if (EXEMPT.has(rel)) continue;
    const n = countOutsideComments(readFileSync(file, 'utf8'), pattern);
    if (n > 0) found.set(rel, n);
  }
  return found;
}

function describeDelta(
  actual: Map<string, number>,
  baseline: ReadonlyMap<string, { readonly count: number }>,
  noun: string,
  adviceOnNew: string,
): string[] {
  const problems: string[] = [];

  for (const [rel, n] of actual) {
    const known = baseline.get(rel);
    if (known === undefined) {
      problems.push(`${rel}: ${n} ${noun}, NOT in the baseline — ${adviceOnNew}`);
    } else if (known.count !== n) {
      const verb = n < known.count ? 'converted' : 'added';
      problems.push(
        `${rel}: baseline says ${known.count}, found ${n} — ${verb} ${Math.abs(n - known.count)} site(s). Update the baseline in this commit.`,
      );
    }
  }

  for (const [rel, known] of baseline) {
    if (!actual.has(rel)) {
      problems.push(`${rel}: baseline claims ${known.count} ${noun}, found 0 — all gone, delete the entry.`);
    }
  }

  return problems;
}

describe('Architecture — settlement-primitive adoption in payments/application (money-remediation Task 12a)', () => {
  it('every raw paymentsRepo.withTx site is accounted for in KNOWN_RAW_WITHTX', () => {
    const actual = scan(RAW_WITHTX);
    const problems = describeDelta(
      actual,
      KNOWN_RAW_WITHTX,
      'raw withTx site(s)',
      'adopt runTxDecided, or add an entry saying why not.',
    );

    expect(
      problems,
      `Settlement-adoption baseline is out of date.\n\n${problems.join('\n')}\n\n` +
        `This is an ADOPTION scan: it does not check whether any transaction takes the right exit.`,
    ).toEqual([]);
  });

  it(`pins the unconverted total at ${RAW_WITHTX_TOTAL} so the inventory cannot be trimmed without converting code`, () => {
    const scanned = [...scan(RAW_WITHTX).values()].reduce((a, b) => a + b, 0);
    const claimed = [...KNOWN_RAW_WITHTX.values()].reduce((a, b) => a + b.count, 0);

    expect(
      claimed,
      `KNOWN_RAW_WITHTX sums to ${claimed} but RAW_WITHTX_TOTAL is pinned at ${RAW_WITHTX_TOTAL}. ` +
        `Converting sites is the only legitimate way to move this number — lower BOTH, in the same commit as the code change.`,
    ).toBe(RAW_WITHTX_TOTAL);

    expect(
      scanned,
      `Source has ${scanned} raw withTx site(s); the pinned total is ${RAW_WITHTX_TOTAL}.`,
    ).toBe(RAW_WITHTX_TOTAL);
  });

  it('every commitTxWithRefusal caller is inventoried (unfenced escape hatch — commits AND refuses)', () => {
    const actual = scan(COMMIT_WITH_REFUSAL);
    const problems = describeDelta(
      actual,
      KNOWN_COMMIT_WITH_REFUSAL,
      'commitTxWithRefusal call(s)',
      'inventory it, stating whether the surviving write is forensic (correct) or money-side (finding F-1).',
    );

    expect(
      problems,
      `commitTxWithRefusal usage changed.\n\n${problems.join('\n')}\n\n` +
        `It commits the transaction and still returns a refusal. Correct for forensic/audit rows; ` +
        `finding F-1 for anything money-side. Add an entry stating which it is.`,
    ).toEqual([]);
  });

  it('EXEMPT entries still exist (no stale exemptions)', () => {
    const present = new Set(listScannedFiles().map(relPath));
    const stale = [...EXEMPT.keys()].filter((rel) => !present.has(rel));

    expect(stale, `Stale EXEMPT entries (file moved or deleted — remove them):\n${stale.join('\n')}`).toEqual([]);
  });
});
