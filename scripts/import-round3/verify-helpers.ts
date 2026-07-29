/**
 * Round-3 post-import verifier — PURE helpers (Part 3 of the Round-3
 * import; docs/import/ROUND3_PLAN.md § Verify).
 *
 * No DB / env imports — unit-tested in
 * tests/unit/scripts/verify-round3-helpers.test.ts. The read-only CLI that
 * feeds these from live rows is scripts/verify-round3-import.ts.
 */

export interface ParsedDocNumber {
  readonly prefix: string;
  readonly fiscalYear: number;
  readonly seq: number;
}

/**
 * Parse a system document number of the canonical
 * `{PREFIX}-{YYYY}-{NNNNNN}` shape (domain/value-objects/document-number.ts).
 * Returns null on any deviation — the verifier treats unparseable raws as a
 * failed assertion, never a silent skip.
 */
export function parseDocNumberRaw(raw: string): ParsedDocNumber | null {
  const m = /^([A-Z0-9]+)-(\d{4})-(\d{6})$/.exec(raw);
  if (!m) return null;
  return {
    prefix: m[1]!,
    fiscalYear: Number(m[2]!),
    seq: Number(m[3]!),
  };
}

/** Cap for listing individual missing member numbers before summarising. */
const MISSING_LIST_CAP = 20;

/**
 * Assert the member_number set is EXACTLY 1..expectedCount (gapless, no
 * duplicates, nothing out of range). Returns human-readable, PII-free
 * problem lines (empty array = pass).
 */
export function findMemberNumberProblems(
  numbers: readonly number[],
  expectedCount: number,
): string[] {
  const problems: string[] = [];
  const seen = new Set<number>();
  for (const n of numbers) {
    if (n < 1 || n > expectedCount) {
      problems.push(`out-of-range member_number ${n} (expected 1..${expectedCount})`);
      continue;
    }
    if (seen.has(n)) {
      problems.push(`duplicate member_number ${n}`);
      continue;
    }
    seen.add(n);
  }
  const missing: number[] = [];
  for (let n = 1; n <= expectedCount; n += 1) {
    if (!seen.has(n)) missing.push(n);
  }
  if (missing.length > MISSING_LIST_CAP) {
    problems.push(
      `missing ${missing.length} member_number values (first ${MISSING_LIST_CAP}: ` +
        `${missing.slice(0, MISSING_LIST_CAP).join(', ')}, …)`,
    );
  } else {
    for (const n of missing) problems.push(`missing member_number ${n}`);
  }
  return problems;
}

export interface SequenceRowLite {
  readonly documentType: string;
  readonly fiscalYear: number;
  readonly nextSequenceNumber: number;
}

/** The two streams the Round-3 import mints into. */
const CHECKED_STREAMS = ['bill', 'receipt'] as const;

/**
 * Cross-check tenant_document_sequences against the maxima actually minted
 * onto invoices (bill_document_number_raw / receipt_document_number_raw).
 *
 * For every (stream, fiscal year) present on EITHER side:
 *   next_sequence_number MUST equal (max minted seq) + 1 — anything lower
 *   risks re-minting a taken number (unique-index abort on the next issue);
 *   anything higher is an unexplained gap right after a clean import.
 * A stream/FY with minted documents but NO sequence row is also a failure.
 * Streams other than bill/receipt are ignored here (the CLI reports them
 * as informational lines).
 */
export function checkSequenceConsistency(
  rows: readonly SequenceRowLite[],
  minted: ReadonlyMap<string, ReadonlyMap<number, number>>,
): string[] {
  const problems: string[] = [];
  for (const stream of CHECKED_STREAMS) {
    const mintedByFy = minted.get(stream) ?? new Map<number, number>();
    const rowsByFy = new Map<number, number>();
    for (const r of rows) {
      if (r.documentType === stream) rowsByFy.set(r.fiscalYear, r.nextSequenceNumber);
    }
    const fys = new Set<number>([...mintedByFy.keys(), ...rowsByFy.keys()]);
    for (const fy of [...fys].sort((a, b) => a - b)) {
      const max = mintedByFy.get(fy) ?? 0;
      const next = rowsByFy.get(fy);
      const expected = max + 1;
      if (next === undefined) {
        if (max > 0) {
          problems.push(
            `${stream} FY${fy}: ${max} document(s) minted but no ` +
              `tenant_document_sequences row exists`,
          );
        }
        continue;
      }
      if (next !== expected) {
        problems.push(
          `${stream} FY${fy}: next_sequence_number ${next} != expected ${expected} ` +
            `(max minted ${max})`,
        );
      }
    }
  }
  return problems;
}
