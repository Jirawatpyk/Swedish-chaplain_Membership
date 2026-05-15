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
 * Safety hardening (Round 2 review):
 *   - Tenant scope is asserted via `runInTenant` so RLS + FORCE
 *     policies are enforced (Constitution Principle I).
 *   - TenantId is regex-validated (DNS-safe slug) before use.
 *   - Audit row selection ORDER BY timestamp DESC LIMIT 1 — the
 *     newest `invoice_paid` is authoritative if the invoice was
 *     re-issued after a void (rare edge case but documented).
 *   - Per-row try/catch + structured skip-reason counters so partial
 *     failure surfaces in the summary instead of aborting the loop.
 *   - The recovered number is regex-validated against the Thai-RD
 *     document-number shape `<PREFIX>-<YEAR>-<SEQ>` before write,
 *     defending against audit-payload tampering.
 *   - `--dry-run` flag lists the candidate updates without writing.
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

const TENANT_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
// Thai RD document number shape: <PREFIX>-<FISCAL-YEAR>-<6-DIGIT-SEQ>
// Prefix is 1-20 chars upper-alpha / digit (matches the
// `receipt_number_prefix` zod constraint at the Application layer).
const DOC_NUM_RE = /^[A-Z0-9]{1,20}-\d{4}-\d{6,9}$/;

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

  // All DB I/O is scoped through `runInTenant` so `SET LOCAL
  // app.current_tenant = '<slug>'` fires before any SELECT/UPDATE.
  // Both `invoices` and `audit_log` enforce RLS + FORCE policies —
  // without this wrapper writes would silently no-op (zero rows
  // affected) under the default app role.
  const summary = await runInTenant(ctx, async (tx) => {
    const candidates = await tx
      .select({ invoiceId: invoices.invoiceId })
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, tenant),
          eq(invoices.status, 'paid'),
          isNull(invoices.receiptDocumentNumberRaw),
        ),
      );

    const stats = {
      candidates: candidates.length,
      backfilled: 0,
      skippedNoAudit: 0,
      skippedCombinedMode: 0,
      skippedMalformedNumber: 0,
      skippedDbError: 0,
    };

    for (const c of candidates) {
      try {
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
          console.log(`  ${c.invoiceId} → no invoice_paid audit found; skipping`);
          stats.skippedNoAudit++;
          continue;
        }
        const payload = rows[0]!.payload as Record<string, unknown>;
        const raw =
          typeof payload.receipt_document_number === 'string'
            ? payload.receipt_document_number
            : null;
        if (!raw) {
          console.log(
            `  ${c.invoiceId} → audit payload lacks receipt_document_number (combined-mode legitimate skip)`,
          );
          stats.skippedCombinedMode++;
          continue;
        }
        if (!DOC_NUM_RE.test(raw)) {
          console.error(
            `  ${c.invoiceId} → audit payload receipt_document_number="${raw}" failed regex; refusing to backfill (potential tampering)`,
          );
          stats.skippedMalformedNumber++;
          continue;
        }

        if (dryRun) {
          console.log(
            `  ${c.invoiceId} → DRY-RUN would backfill receipt_document_number_raw = ${raw}`,
          );
        } else {
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
        }
        stats.backfilled++;
      } catch (err) {
        console.error(`  ${c.invoiceId} → DB error: ${String(err)}`);
        stats.skippedDbError++;
      }
    }

    return stats;
  });

  console.log(
    `\n[backfill] ${dryRun ? 'dry-run ' : ''}done — ${summary.backfilled} ${
      dryRun ? 'would-backfill' : 'backfilled'
    }, ${summary.skippedCombinedMode} combined-mode, ${summary.skippedNoAudit} no-audit, ${summary.skippedMalformedNumber} malformed, ${summary.skippedDbError} db-error (${summary.candidates} total candidates)`,
  );

  // Non-zero exit code on partial failure so CI / cron wrappers can
  // surface errors instead of swallowing them.
  if (summary.skippedDbError > 0 || summary.skippedMalformedNumber > 0) {
    process.exit(3);
  }
  process.exit(0);
}

void main();
