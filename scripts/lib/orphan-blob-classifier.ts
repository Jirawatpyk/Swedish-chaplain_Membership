/**
 * Orphan invoice-blob classifier — PURE core for
 * `scripts/sweep-orphan-invoice-blobs.ts` (post-import housekeeping item 9).
 * No env/db/blob imports so the classification rules are unit-testable
 * (tests/unit/scripts/orphan-blob-classifier.test.ts).
 *
 * KEY PATTERNS under `invoicing/<tenantId>/` — enumerated from the real
 * writers (grep `invoicing/` in src/modules/invoicing/application/use-cases):
 *   - invoice PDF      `invoicing/<t>/<fy>/<invoiceId>_v<n>.pdf`
 *                      (issue-invoice.ts:656, issue-event-invoice-as-paid.ts:548)
 *   - receipt PDF      `invoicing/<t>/<fy>/<invoiceId>_receipt_v<n>.pdf`
 *                      (record-payment.ts:822, render-receipt-pdf.ts:242)
 *   - credit-note PDF  `invoicing/<t>/<fy>/credit-note_<cnId>_v<n>.pdf`
 *                      (issue-credit-note.ts:812)
 *   - zero-rate cert   `invoicing/<t>/zero-rate-certs/<invoiceId>_<ms>.<ext>`
 *                      (upload-zero-rate-cert.ts:123)
 *   - tenant logo      `invoicing/<t>/logos/<uuid>.<png|jpg|jpeg>`
 *                      (upload-tenant-logo.ts)
 * VOID overlays OVERWRITE the invoice-PDF key in place (vercel-blob-adapter
 * `allowOverwrite`) — no separate key family exists for them.
 *
 * SAFETY MODEL: a key that matches NO known pattern classifies `unknown`
 * and its verdict is `unknown_kept` — NEVER deletable, even under
 * `--commit`. Deletion is reserved for keys that (a) match a known pattern
 * AND (b) are referenced by no DB column. The referenced-set is provided by
 * the caller (the CLI enumerates EVERY blob-key column — see its header).
 */

export type InvoicingBlobKind =
  | 'invoice_pdf'
  | 'receipt_pdf'
  | 'credit_note_pdf'
  | 'zero_rate_cert'
  | 'logo'
  | 'unknown';

export type SweepVerdict = 'referenced' | 'orphan' | 'unknown_kept';

export interface ListedBlob {
  readonly key: string;
  readonly sizeBytes: number;
}

export interface SweepRow {
  readonly key: string;
  readonly sizeBytes: number;
  readonly kind: InvoicingBlobKind;
  readonly verdict: SweepVerdict;
}

export interface SweepReport {
  readonly rows: readonly SweepRow[];
  readonly listedCount: number;
  readonly listedBytes: number;
  readonly referencedCount: number;
  readonly orphanCount: number;
  readonly orphanBytes: number;
  readonly unknownKeptCount: number;
  /** DB-referenced keys ABSENT from the Blob listing (anomaly — never deleted, only reported). */
  readonly referencedMissing: readonly string[];
}

const UUID = '[0-9a-fA-F-]{36}';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Classify one listed key by the writer patterns above. Order matters:
 *  `_receipt_v` and `credit-note_` are checked BEFORE the generic invoice
 *  shape (all three live under the same `<fy>/` segment and end `_v<n>.pdf`). */
export function classifyInvoicingBlobKey(
  key: string,
  tenantId: string,
): InvoicingBlobKind {
  const t = escapeRe(tenantId);
  if (new RegExp(`^invoicing/${t}/\\d{4}/${UUID}_receipt_v\\d+\\.pdf$`).test(key)) {
    return 'receipt_pdf';
  }
  if (
    new RegExp(`^invoicing/${t}/\\d{4}/credit-note_${UUID}_v\\d+\\.pdf$`).test(key)
  ) {
    return 'credit_note_pdf';
  }
  if (new RegExp(`^invoicing/${t}/\\d{4}/${UUID}_v\\d+\\.pdf$`).test(key)) {
    return 'invoice_pdf';
  }
  if (
    new RegExp(`^invoicing/${t}/zero-rate-certs/${UUID}_\\d+\\.[A-Za-z0-9]+$`).test(
      key,
    )
  ) {
    return 'zero_rate_cert';
  }
  if (new RegExp(`^invoicing/${t}/logos/[^/]+$`).test(key)) {
    return 'logo';
  }
  return 'unknown';
}

/**
 * Cross-reference the Blob listing against the DB-referenced key set.
 *   - referenced → key appears in ANY blob-key column (safe, kept)
 *   - orphan     → known pattern + referenced nowhere (deletable on --commit)
 *   - unknown_kept → unrecognised pattern (kept even on --commit; a
 *     referenced unknown key still reports `referenced`)
 */
export function classifyOrphanBlobs(
  tenantId: string,
  listed: readonly ListedBlob[],
  referencedKeys: ReadonlySet<string>,
): SweepReport {
  const rows: SweepRow[] = listed.map((b) => {
    const kind = classifyInvoicingBlobKey(b.key, tenantId);
    const verdict: SweepVerdict = referencedKeys.has(b.key)
      ? 'referenced'
      : kind === 'unknown'
        ? 'unknown_kept'
        : 'orphan';
    return { key: b.key, sizeBytes: b.sizeBytes, kind, verdict };
  });

  const listedKeySet = new Set(listed.map((b) => b.key));
  const referencedMissing = [...referencedKeys]
    .filter((k) => !listedKeySet.has(k))
    .sort();

  const orphans = rows.filter((r) => r.verdict === 'orphan');
  return {
    rows,
    listedCount: rows.length,
    listedBytes: rows.reduce((a, r) => a + r.sizeBytes, 0),
    referencedCount: rows.filter((r) => r.verdict === 'referenced').length,
    orphanCount: orphans.length,
    orphanBytes: orphans.reduce((a, r) => a + r.sizeBytes, 0),
    unknownKeptCount: rows.filter((r) => r.verdict === 'unknown_kept').length,
    referencedMissing,
  };
}
