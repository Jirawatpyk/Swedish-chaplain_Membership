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
 * it, syncs the sha, re-enqueues the cancellation email the blob_upload leg
 * lost, and clears the marker.
 *
 * A voided tax document is NEVER abandoned un-stamped: transient infra / render
 * failures retry INDEFINITELY (SQL-incremented attempts, a deduped escalation
 * alert past a threshold — the row stays pending). Only GENUINE, retry-proof
 * corruption (a missing snapshot / a null void_reason) is parked.
 *
 * Per-row work runs inside ONE `runInTenant` tx holding `lockForUpdate` on the
 * invoice, so overlapping Vercel-cron ticks serialise (the re-render is not
 * byte-deterministic — two unserialised ticks would upload divergent bytes). The
 * render + each blob upload are bounded by a timeout so a hung network call
 * cannot hold the row lock (and its pool connection) indefinitely.
 *
 * Native Vercel cron (GET, UTC, CRON_SECRET bearer). Mirrors
 * `receipt-pdf-reconcile`. Runbook: docs/runbooks/refund-without-credit-note.md
 * (void-restamp section).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import { db, runInTenant, type TenantTx } from '@/lib/db';
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
// Bound the render + each blob upload so a hung network call cannot hold the
// invoice row lock (and its pool connection) forever — the pooled Neon endpoint
// drops statement_timeout to 0, so the DB will not kill an idle-in-transaction
// tx waiting on an app-level `await`. On timeout the callback throws → the tx
// rolls back → the lock releases → the row retries next tick. Env-overridable
// for tests. (The orphaned fetch keeps a handler from `Promise.race`, so its
// eventual settle is not an unhandled rejection.)
const DEFAULT_RENDER_TIMEOUT_MS = 30_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 20_000;

class ReconcileTimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ReconcileTimeoutError(`void_pdf_reconcile timeout: ${label}`)),
      ms,
    );
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Bump `attempts` then read back the ACTUAL, post-bump value — but ONLY if the
 * row is still actionable (pending + un-parked). Returns `null` when a racing
 * tick cleared/parked the row between the bump's WHERE match and this read, so
 * the caller never escalates a row that was just reconciled (the bump's WHERE is
 * `pending IS NOT NULL AND parked IS NULL`, so on a race it increments nothing).
 * Basing the escalation on the true value (not the stale scan snapshot) also
 * avoids off-by-a-tick threshold drift when a prior tick already bumped.
 */
async function bumpAndReadActionableAttempts(
  tx: TenantTx,
  repo: ReturnType<typeof makeDrizzleInvoiceRepo>,
  tenantId: string,
  invoiceId: ReturnType<typeof asInvoiceId>,
): Promise<number | null> {
  await repo.bumpVoidPdfReconcileAttempts(tx, { tenantId, invoiceId });
  const [r] = await tx
    .select({
      attempts: invoices.voidPdfReconcileAttempts,
      pendingAt: invoices.voidPdfReconcilePendingAt,
      parkedAt: invoices.voidPdfReconcileParkedAt,
    })
    .from(invoices)
    .where(and(eq(invoices.tenantId, tenantId), eq(invoices.invoiceId, invoiceId)));
  return r && r.pendingAt !== null && r.parkedAt === null ? r.attempts : null;
}

/**
 * Re-enqueue the cancellation email the blob_upload leg lost. `voidInvoice`
 * enqueues the FR-036 notice in Phase 1 pinned to the VOID-stamped sha the
 * upload never produced, so the dispatcher permanent-fails it on the un-stamped
 * bytes — the member never learns the invoice was cancelled. After this cron
 * re-uploads the stamped bytes, copy the ORIGINAL row's context (recipient,
 * locale, doc number, reason) and re-pin it to the freshly-uploaded `sha_cron`.
 *
 * The SELECT is the intent gate: a SUPPRESSED void (void-on-reissue) never
 * enqueued a row, so nothing is copied and no spurious email is sent. Runs
 * inside the reconcile tx (atomic with the sha sync + clear). Returns whether a
 * row was re-enqueued. Idempotent across ticks: the reconcile clears the marker
 * on success, and the marker re-check below skips a row a racing tick already
 * cleared, so exactly one re-enqueue happens per recovered void.
 */
async function reEnqueueVoidCancellationEmail(
  tx: TenantTx,
  tenantId: string,
  invoiceId: string,
  newSha: string,
): Promise<boolean> {
  const inserted = (await tx.execute(sql`
    INSERT INTO notifications_outbox
      (tenant_id, notification_type, to_email, locale, context_data, status, attempts, next_retry_at)
    SELECT tenant_id, notification_type, to_email, locale,
           jsonb_set(context_data, '{expected_pdf_sha256}', to_jsonb(${newSha}::text)),
           'pending'::outbox_status, 0, now()
      FROM notifications_outbox
     WHERE tenant_id = ${tenantId}
       AND notification_type = 'invoice_auto_email'::notification_type
       AND context_data->>'event_type' = 'invoice_voided'
       AND context_data->>'invoice_id' = ${invoiceId}
     ORDER BY created_at DESC
     LIMIT 1
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return inserted.length > 0;
}

type AlertDisposition = 'parked' | 'escalated_retrying';

async function alertOncePermanentlyFailed(
  tenantId: string,
  invoiceId: string,
  requestId: string,
  attempts: number,
  reason: string,
  disposition: AlertDisposition,
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
    // `disposition` distinguishes a PARK (retry-proof corruption — needs manual
    // repair, off the scan) from an escalated-but-still-retrying row (transient,
    // self-heals) so an operator reading the audit knows which it is.
    const summary =
      disposition === 'parked'
        ? `Void §86/4 re-stamp PARKED for invoice ${invoiceId} (${reason}) — manual repair required`
        : `Void §86/4 re-stamp escalated for invoice ${invoiceId} (${reason}) — still retrying`;
    await f4AuditAdapter.emit(null, {
      tenantId,
      requestId,
      eventType: 'pdf_render_permanently_failed',
      actorUserId: 'system:cron',
      summary,
      payload: {
        invoice_id: invoiceId,
        attempts,
        reason,
        disposition,
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

  const renderTimeoutMs =
    Number(process.env.VOID_RECONCILE_RENDER_TIMEOUT_MS) || DEFAULT_RENDER_TIMEOUT_MS;
  const uploadTimeoutMs =
    Number(process.env.VOID_RECONCILE_UPLOAD_TIMEOUT_MS) || DEFAULT_UPLOAD_TIMEOUT_MS;

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
  let emailsReenqueued = 0;

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
        // Idempotency re-check UNDER the lock: a racing tick (both scanned the
        // row before either committed) may have already reconciled + cleared it.
        // Without this a second tick would re-render, re-upload divergent bytes,
        // AND re-enqueue a DUPLICATE cancellation email. The scan's
        // `pending_at IS NOT NULL` filter only covers sequential ticks.
        const [marker] = await tx
          .select({ pendingAt: invoices.voidPdfReconcilePendingAt })
          .from(invoices)
          .where(
            and(
              eq(invoices.tenantId, row.tenantId),
              eq(invoices.invoiceId, row.invoiceId),
            ),
          );
        if (!marker || marker.pendingAt === null) {
          return { kind: 'cleared' as const };
        }
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
        const built = await withTimeout(
          buildVoidRenderTargets(
            { pdfRender: reactPdfRenderAdapter, blob: vercelBlobAdapter },
            loaded,
            loaded.voidReason,
          ),
          renderTimeoutMs,
          'render',
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
          const attempts = await bumpAndReadActionableAttempts(
            tx,
            repo,
            row.tenantId,
            invoiceId,
          );
          return { kind: 'bumped' as const, reason: 'pdf_render_failed', attempts };
        }
        // Upload each target's freshly-rendered bytes + sync its sha.
        //
        // Partial-failure note: the blob is NOT transactional. If a second
        // target's upload throws, this tx rolls back — reverting the first
        // target's sha write but NOT its already-overwritten blob bytes. That
        // leaves a TRANSIENT DB-sha-lags-blob split on the first target (the
        // served doc is correctly VOID-stamped — tax-safe). The marker stays
        // pending (the clear rolled back too), so a later all-succeed tick
        // re-uploads both + re-syncs both shas and converges.
        const targets = built.value.targetB
          ? [built.value.targetA, built.value.targetB]
          : [built.value.targetA];
        for (const t of targets) {
          await withTimeout(
            vercelBlobAdapter.uploadPdf({
              key: t.blobKey,
              body: t.rendered.bytes,
              contentType: 'application/pdf',
              allowOverwrite: true,
            }),
            uploadTimeoutMs,
            'upload',
          );
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
        // Re-enqueue the lost cancellation email pinned to the MAIN (§86/4)
        // blob's freshly-uploaded sha. Intent-gated on an existing void row, so
        // a suppressed void-on-reissue never sends one.
        const reEnqueued = await reEnqueueVoidCancellationEmail(
          tx,
          row.tenantId,
          row.invoiceId,
          built.value.targetA.rendered.sha256,
        );
        await repo.clearVoidPdfReconcileMarker(tx, {
          tenantId: row.tenantId,
          invoiceId,
        });
        return { kind: 'reconciled' as const, reEnqueued };
      });

      if (outcome.kind === 'reconciled') {
        reconciled += 1;
        if (outcome.reEnqueued) emailsReenqueued += 1;
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
          'parked',
        );
      } else {
        // bumped — escalate a deduped alert once past the threshold; the row
        // stays pending and keeps retrying. `outcome.attempts` is the true
        // post-bump value (null if a racing tick cleared/parked it first).
        bumped += 1;
        if (outcome.attempts !== null && outcome.attempts >= ESCALATION_THRESHOLD) {
          await alertOncePermanentlyFailed(
            row.tenantId,
            row.invoiceId,
            requestId,
            outcome.attempts,
            outcome.reason,
            'escalated_retrying',
          );
        }
      }
    } catch (e) {
      // Transient infra failure (blob/DB/timeout) — the tx rolled back, so the
      // marker is untouched (still pending). Bump attempts in a fresh tx so the
      // escalation clock advances; never park (never abandon a voided tax doc).
      errored += 1;
      try {
        const attempts = await runInTenant(ctx, (tx) =>
          bumpAndReadActionableAttempts(tx, repo, row.tenantId, invoiceId),
        );
        if (attempts !== null && attempts >= ESCALATION_THRESHOLD) {
          await alertOncePermanentlyFailed(
            row.tenantId,
            row.invoiceId,
            requestId,
            attempts,
            'reconcile_infra_error',
            'escalated_retrying',
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
    {
      requestId,
      total: rows.length,
      reconciled,
      bumped,
      parked,
      cleared,
      errored,
      emailsReenqueued,
    },
    'cron.void_pdf_reconcile.completed',
  );

  return NextResponse.json(
    {
      ok: true,
      total: rows.length,
      reconciled,
      bumped,
      parked,
      cleared,
      errored,
      emailsReenqueued,
    },
    { status: 200 },
  );
}
