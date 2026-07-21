/**
 * Bug 10 (money-remediation) — void §86/4 PDF re-stamp reconcile cron.
 *
 * `voidInvoice` uploads the VOID-stamped §86/4 best-effort in Phase 2. When the
 * blob upload FAILS (the blob_upload leg), the served §86/4 keeps its ORIGINAL
 * un-stamped bytes on a voided sale — tax-dangerous, and undetectable by a
 * sha-mismatch check. `voidInvoice` marks such a row
 * (`void_pdf_reconcile_pending_at`); this cron re-renders the VOID overlay from
 * the persisted aggregate (via the SHARED `buildVoidRenderTargets` helper, so
 * the WHT note + §80/1(5) zero-rate + kind-true titling are reproduced), uploads
 * it, syncs the sha, and clears the marker.
 *
 * A voided tax document is NEVER abandoned un-stamped: transient infra / render
 * failures retry INDEFINITELY (SQL-incremented attempts, a deduped escalation
 * alert past a threshold — the row stays pending). Only GENUINE, retry-proof
 * corruption (a missing snapshot / a null void_reason) is parked.
 *
 * Per-row work runs inside ONE `runInTenant` tx holding `lockForUpdate` on the
 * invoice, so overlapping Vercel-cron ticks serialise (the re-render is not
 * byte-deterministic — two unserialised ticks would upload divergent bytes).
 *
 * Native Vercel cron (GET, UTC, CRON_SECRET bearer). Mirrors
 * `receipt-pdf-reconcile`. Runbook: docs/runbooks/refund-without-credit-note.md
 * (void-restamp section).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import { db, runInTenant } from '@/lib/db';
import { verifyCronBearer } from '@/lib/cron-auth';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { requestIdFromHeaders } from '@/lib/request-id';
import { asInvoiceId } from '@/modules/invoicing/domain/invoice';
import { asTenantContext } from '@/modules/tenants';
import { makeDrizzleInvoiceRepo, f4AuditAdapter } from '@/modules/invoicing';
import { buildVoidRenderTargets } from '@/modules/invoicing/application/lib/build-void-render-targets';
// Deep imports — the cross-tenant maintenance escape hatch (mirrors
// receipt-pdf-reconcile): the render adapter + raw schema tables are not
// barrel-exported (that would invite raw-SQL / render coupling into product
// code). This route is operational infrastructure.
import { reactPdfRenderAdapter } from '@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter';
import { vercelBlobAdapter } from '@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SCAN_LIMIT = 100;
// Escalation, NOT abandonment — past this many failed ticks a deduped alert
// fires but the row stays pending and keeps retrying (a voided §86/4 must never
// be left un-stamped). Parking is reserved for retry-proof corruption.
const ESCALATION_THRESHOLD = 5;

async function alertOncePermanentlyFailed(
  tenantId: string,
  invoiceId: string,
  requestId: string,
  attempts: number,
  reason: string,
): Promise<boolean> {
  // Dedupe + emit inside runInTenant so RLS on audit_log resolves to the row's
  // tenant (a bare read leaves app.current_tenant unset → zero rows → re-emit
  // every tick → double-paging). Verbatim mirror of receipt-pdf-reconcile.
  return runInTenant(asTenantContext(tenantId), async () => {
    const existing = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantId),
          eq(auditLog.eventType, 'pdf_render_permanently_failed'),
          sql`${auditLog.payload}->>'invoice_id' = ${invoiceId}`,
          sql`${auditLog.payload}->>'source' = 'cron.void_pdf_reconcile'`,
        ),
      )
      .limit(1);
    if (existing.length > 0) return false;
    await f4AuditAdapter.emit(null, {
      tenantId,
      requestId,
      eventType: 'pdf_render_permanently_failed',
      actorUserId: 'system:cron',
      summary: `Void §86/4 re-stamp reconcile escalated for invoice ${invoiceId} (${reason})`,
      payload: {
        invoice_id: invoiceId,
        attempts,
        reason,
        source: 'cron.void_pdf_reconcile',
      },
    });
    return true;
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);

  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) {
    logger.error({ requestId }, 'cron.void_pdf_reconcile.secret_misconfigured');
    return NextResponse.json(
      { error: 'server_misconfiguration' },
      { status: 500 },
    );
  }
  if (!verifyCronBearer(request.headers.get('authorization'), secret)) {
    logger.warn({ requestId }, 'cron.void_pdf_reconcile.unauthorized');
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Cross-tenant scan of actionable rows. RLS bypass is intentional (ops surface
  // gated by CRON_SECRET); each row drives tenant-scoped follow-up below.
  let rows: Array<{
    tenantId: string;
    invoiceId: string;
    attempts: number;
  }> = [];
  try {
    rows = await db
      .select({
        tenantId: invoices.tenantId,
        invoiceId: invoices.invoiceId,
        attempts: invoices.voidPdfReconcileAttempts,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.status, 'void'),
          isNotNull(invoices.voidPdfReconcilePendingAt),
          isNull(invoices.voidPdfReconcileParkedAt),
        ),
      )
      .orderBy(invoices.voidPdfReconcilePendingAt)
      .limit(SCAN_LIMIT);
  } catch (e) {
    logger.error(
      { requestId, err: errKind(e) },
      'cron.void_pdf_reconcile.scan_failed',
    );
    return NextResponse.json({ error: 'scan_failed' }, { status: 500 });
  }

  let reconciled = 0;
  let bumped = 0;
  let parked = 0;
  let cleared = 0;
  let errored = 0;

  for (const row of rows) {
    const ctx = asTenantContext(row.tenantId);
    const repo = makeDrizzleInvoiceRepo(row.tenantId);
    const invoiceId = asInvoiceId(row.invoiceId);
    try {
      // outcome escapes the tx so we can escalate/log AFTER commit.
      const outcome = await runInTenant(ctx, async (tx) => {
        // Serialise overlapping ticks — the re-render is not byte-deterministic,
        // so two concurrent ticks would upload divergent bytes.
        await repo.lockForUpdate(tx, invoiceId, row.tenantId);
        const loaded = await repo.findByIdInTx(tx, invoiceId, row.tenantId);
        if (!loaded || loaded.status !== 'void') {
          // The void was undone / the row vanished — nothing to reconcile.
          await repo.clearVoidPdfReconcileMarker(tx, {
            tenantId: row.tenantId,
            invoiceId,
          });
          return { kind: 'cleared' as const };
        }
        if (loaded.voidReason === null) {
          // Retry-proof corruption — a void row must carry a reason.
          await repo.parkVoidPdfReconcile(tx, {
            tenantId: row.tenantId,
            invoiceId,
          });
          return { kind: 'parked' as const, reason: 'null_void_reason' };
        }
        const built = await buildVoidRenderTargets(
          { pdfRender: reactPdfRenderAdapter, blob: vercelBlobAdapter },
          loaded,
          loaded.voidReason,
        );
        if (!built.ok) {
          if (built.error.code === 'no_snapshot_on_invoice') {
            // Retry-proof corruption — a missing snapshot never appears on retry.
            await repo.parkVoidPdfReconcile(tx, {
              tenantId: row.tenantId,
              invoiceId,
            });
            return { kind: 'parked' as const, reason: 'no_snapshot_on_invoice' };
          }
          // pdf_render_failed — possibly transient; retry (never abandon a
          // voided tax doc). Bump + escalate past the threshold, stay pending.
          await repo.bumpVoidPdfReconcileAttempts(tx, {
            tenantId: row.tenantId,
            invoiceId,
          });
          return { kind: 'bumped' as const, reason: 'pdf_render_failed' };
        }
        // Upload each target's freshly-rendered bytes + sync its sha.
        const targets = built.value.targetB
          ? [built.value.targetA, built.value.targetB]
          : [built.value.targetA];
        for (const t of targets) {
          await vercelBlobAdapter.uploadPdf({
            key: t.blobKey,
            body: t.rendered.bytes,
            contentType: 'application/pdf',
            allowOverwrite: true,
          });
          if (t.persist === 'invoice') {
            await repo.applyInvoicePdfRegeneration(tx, {
              tenantId: row.tenantId,
              invoiceId,
              pdfSha256: t.rendered.sha256,
            });
          } else {
            await repo.applyReceiptPdfRegeneration(tx, {
              tenantId: row.tenantId,
              invoiceId,
              receiptPdfSha256: t.rendered.sha256,
            });
          }
        }
        await repo.clearVoidPdfReconcileMarker(tx, {
          tenantId: row.tenantId,
          invoiceId,
        });
        return { kind: 'reconciled' as const };
      });

      if (outcome.kind === 'reconciled') {
        reconciled += 1;
      } else if (outcome.kind === 'cleared') {
        cleared += 1;
      } else if (outcome.kind === 'parked') {
        parked += 1;
        await alertOncePermanentlyFailed(
          row.tenantId,
          row.invoiceId,
          requestId,
          row.attempts,
          outcome.reason,
        );
      } else {
        // bumped — escalate a deduped alert once past the threshold; the row
        // stays pending and keeps retrying.
        bumped += 1;
        if (row.attempts + 1 >= ESCALATION_THRESHOLD) {
          await alertOncePermanentlyFailed(
            row.tenantId,
            row.invoiceId,
            requestId,
            row.attempts + 1,
            outcome.reason,
          );
        }
      }
    } catch (e) {
      // Transient infra failure (blob/DB) — the tx rolled back, so the marker is
      // untouched (still pending). Bump attempts in a fresh tx so the escalation
      // clock advances; never park (never abandon a voided tax doc).
      errored += 1;
      try {
        await runInTenant(ctx, async (tx) => {
          await repo.bumpVoidPdfReconcileAttempts(tx, {
            tenantId: row.tenantId,
            invoiceId,
          });
        });
        if (row.attempts + 1 >= ESCALATION_THRESHOLD) {
          await alertOncePermanentlyFailed(
            row.tenantId,
            row.invoiceId,
            requestId,
            row.attempts + 1,
            'reconcile_infra_error',
          );
        }
      } catch (bumpErr) {
        logger.error(
          { requestId, tenantId: row.tenantId, err: errKind(bumpErr) },
          'cron.void_pdf_reconcile.bump_failed',
        );
      }
      logger.error(
        { requestId, tenantId: row.tenantId, err: errKind(e) },
        'cron.void_pdf_reconcile.row_failed',
      );
    }
  }

  logger.info(
    { requestId, total: rows.length, reconciled, bumped, parked, cleared, errored },
    'cron.void_pdf_reconcile.completed',
  );

  return NextResponse.json(
    { ok: true, total: rows.length, reconciled, bumped, parked, cleared, errored },
    { status: 200 },
  );
}
