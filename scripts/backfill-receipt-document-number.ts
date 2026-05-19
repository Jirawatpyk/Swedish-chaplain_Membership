/**
 * One-off — backfill `invoices.receipt_document_number_raw` from the
 * `audit_log.invoice_paid` payload for paid invoices where the sync
 * record-payment path forgot to persist it (pre-2026-05-15 bug).
 *
 * The audit payload always carried `receipt_document_number` so this
 * is non-lossy. The receipt PDF on Blob already has the number
 * rendered into the bytes — backfilling the column simply restores
 * the linkage the UI reads.
 *
 * Safety hardening (Round 2 + Round 3 review):
 *   - PER-ROW `runInTenant` transaction — a DB error on one row no
 *     longer poisons subsequent updates. Round 2 used a single
 *     transaction wrapping the whole loop, which under any DB error
 *     would leave the tx in PostgreSQL aborted state (25P02
 *     "transaction is aborted, commands ignored until end of
 *     transaction block"). Every subsequent row would then fail too,
 *     the JS try/catch would swallow the errors, and the script
 *     would lie about how many rows it backfilled (zero, because the
 *     whole tx rolls back on return). Per-row tx is bounded (each
 *     row is independent) so failure is correctly isolated.
 *   - Tenant scope asserted via `runInTenant` per row → RLS + FORCE
 *     policies enforced (Constitution Principle I) per write.
 *   - TenantId regex-validated (DNS-safe slug) before use.
 *   - Audit row selection ORDER BY timestamp DESC LIMIT 1 — the
 *     newest `invoice_paid` is authoritative if the invoice was
 *     re-issued after a void (rare edge case but documented).
 *   - Per-row try/catch + structured skip-reason counters so partial
 *     failure surfaces in the summary instead of aborting the loop.
 *   - The recovered number is regex-validated against the Thai-RD
 *     `DocumentNumber.parse()` domain regex (Round 3 finding H-2 —
 *     script regex was wider than domain, accepting numbers that the
 *     domain would reject + rejecting valid 6-digit sequences).
 *   - `--dry-run` flag lists candidate updates without writing AND
 *     reports counters as "wouldBackfill" (separate from real
 *     "backfilled" counter so the summary cannot lie about what
 *     happened — Round 3 finding M-2).
 *
 * Usage:
 *   pnpm tsx scripts/backfill-receipt-document-number.ts <tenantId>
 *   pnpm tsx scripts/backfill-receipt-document-number.ts <tenantId> --dry-run
 *
 * Idempotency: only rows with `receipt_document_number_raw IS NULL`
 * are written, so re-running the script is safe.
 */
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { eq, and, isNull, sql, desc } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';

// Tenant slug matches the same shape that `runInTenant` accepts —
// previous script regex diverged (required leading alphanumeric +
// 2-63 chars). Aligned with core invariant for consistency.
const TENANT_SLUG_RE = /^[a-z0-9-]{1,63}$/;
// Thai RD document number shape — aligned with
// `DocumentNumber.parse()` domain regex: PREFIX is one upper-alpha
// followed by up to 7 upper-alpha-or-digit chars; year is exactly 4
// digits; sequence is exactly 6 digits (padding enforced by
// DocumentNumber.of). Round 2 regex was wider on both prefix (allowed
// leading digits, up to 20 chars) and sequence (6-9 digits) — Round 3
// finding H-2 tightens this to match domain truth.
const DOC_NUM_RE = /^[A-Z][A-Z0-9]{0,7}-\d{4}-\d{6}$/;

async function main(): Promise<void> {
  const tenant = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');
  if (!tenant) {
    console.error(
      'Usage: pnpm tsx scripts/backfill-receipt-document-number.ts <tenantId> [--dry-run]',
    );
    process.exit(1);
  }
  if (!TENANT_SLUG_RE.test(tenant)) {
    console.error(
      `[backfill] tenantId "${tenant}" does not match DNS-safe slug pattern; refusing to proceed`,
    );
    process.exit(2);
  }

  const ctx = asTenantContext(tenant);
  console.log(`[backfill] tenant=${tenant} ${dryRun ? '(dry-run)' : ''}`);

  // Phase 1 — discover candidates in a single tx (read-only, safe to
  // share one runInTenant scope). Only `invoiceId` is needed for the
  // worklist; per-row processing opens its own tx below.
  const candidates = await runInTenant(ctx, (tx) =>
    tx
      .select({ invoiceId: invoices.invoiceId })
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, tenant),
          eq(invoices.status, 'paid'),
          isNull(invoices.receiptDocumentNumberRaw),
        ),
      ),
  );

  const stats = {
    candidates: candidates.length,
    backfilled: 0,
    wouldBackfill: 0,
    skippedNoAudit: 0,
    skippedCombinedMode: 0,
    skippedMalformedNumber: 0,
    skippedDbError: 0,
  };

  // Phase 2 — process each candidate in its OWN runInTenant tx. A DB
  // error on one row aborts ONLY that row's tx (rolls back its
  // single UPDATE) and the loop continues to the next row with a
  // fresh tx. Round 2 used a single tx wrapping the whole loop which
  // would poison every subsequent statement on a row failure.
  for (const c of candidates) {
    try {
      const skipReason = await runInTenant(ctx, async (tx) => {
        // ORDER BY timestamp DESC LIMIT 1 — pick the most recent
        // invoice_paid for this invoice. Defends against a rare edge
        // where an invoice was voided + re-issued + re-paid (legacy
        // path before void was terminal); the newest payment carries
        // the authoritative receipt number.
        const rows = await tx
          .select({ payload: auditLog.payload })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.tenantId, tenant),
              eq(auditLog.eventType, 'invoice_paid'),
              sql`${auditLog.payload}->>'invoice_id' = ${c.invoiceId}`,
            ),
          )
          .orderBy(desc(auditLog.timestamp))
          .limit(1);

        if (rows.length === 0) {
          return 'no-audit' as const;
        }
        const payload = rows[0]!.payload as Record<string, unknown>;
        const raw =
          typeof payload.receipt_document_number === 'string'
            ? payload.receipt_document_number
            : null;
        if (!raw) return 'combined-mode' as const;
        if (!DOC_NUM_RE.test(raw)) return { kind: 'malformed' as const, raw };

        if (dryRun) {
          console.log(
            `  ${c.invoiceId} → DRY-RUN would backfill receipt_document_number_raw = ${raw}`,
          );
          return { kind: 'would-backfill' as const, raw };
        }
        await tx
          .update(invoices)
          .set({ receiptDocumentNumberRaw: raw })
          .where(
            and(
              eq(invoices.tenantId, tenant),
              eq(invoices.invoiceId, c.invoiceId),
              // Idempotency belt-and-suspenders: only write if still
              // NULL (race with concurrent record-payment that fixed
              // the value via Bug 3 fix).
              isNull(invoices.receiptDocumentNumberRaw),
            ),
          );
        console.log(`  ${c.invoiceId} → backfilled receipt_document_number_raw = ${raw}`);
        return { kind: 'backfilled' as const, raw };
      });

      if (skipReason === 'no-audit') {
        console.log(`  ${c.invoiceId} → no invoice_paid audit found; skipping`);
        stats.skippedNoAudit++;
      } else if (skipReason === 'combined-mode') {
        console.log(
          `  ${c.invoiceId} → audit payload lacks receipt_document_number (combined-mode legitimate skip)`,
        );
        stats.skippedCombinedMode++;
      } else if (skipReason.kind === 'malformed') {
        console.error(
          `  ${c.invoiceId} → audit payload receipt_document_number="${skipReason.raw}" failed regex; refusing to backfill (potential tampering)`,
        );
        stats.skippedMalformedNumber++;
      } else if (skipReason.kind === 'would-backfill') {
        stats.wouldBackfill++;
      } else {
        stats.backfilled++;
      }
    } catch (err) {
      // Per-row tx is isolated — its rollback is bounded to this row.
      // Continue with the next row in a fresh runInTenant scope.
      console.error(`  ${c.invoiceId} → DB error: ${String(err)}`);
      stats.skippedDbError++;
    }
  }

  console.log(
    `\n[backfill] ${dryRun ? 'dry-run ' : ''}done — ${
      dryRun
        ? `${stats.wouldBackfill} would-backfill`
        : `${stats.backfilled} backfilled`
    }, ${stats.skippedCombinedMode} combined-mode, ${stats.skippedNoAudit} no-audit, ${stats.skippedMalformedNumber} malformed, ${stats.skippedDbError} db-error (${stats.candidates} total candidates)`,
  );

  const summary = stats;

  // Non-zero exit code on partial failure so CI / cron wrappers can
  // surface errors instead of swallowing them.
  if (summary.skippedDbError > 0 || summary.skippedMalformedNumber > 0) {
    process.exit(3);
  }
  process.exit(0);
}

void main();
