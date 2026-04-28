/**
 * T166-11 — Receipt-PDF reconciliation cron.
 *
 * Scheduling (dual-trigger, idempotent — same pattern as
 * `/api/cron/sweep-stale-pending-refunds`):
 *
 *   1. **cron-job.org → primary 5-minute cadence**
 *      URL: https://{deployment}/api/internal/cron/receipt-pdf-reconcile
 *      Header: `Authorization: Bearer ${CRON_SECRET}`
 *      Schedule: minute slash 5 (every 5 minutes)
 *      Rationale: Vercel Hobby caps Vercel Cron at daily cadence.
 *      The 5-minute cadence is needed so a failed-render row recovers
 *      within ≤5 min of the worker bumping `attempts` (T166-11
 *      acceptance criterion).
 *
 *   2. **Vercel Cron → daily fallback**
 *      `vercel.json` schedule "30 3 * * *" (03:30 UTC daily, offset
 *      30 min from sweep-stale-pending-refunds at 03:00 UTC to avoid
 *      simultaneous DB load). Acts as a recovery net if cron-job.org
 *      is degraded or the deployment URL changes faster than
 *      cron-job.org's job is updated.
 *
 * Both triggers hit the same handler. The cron is fully idempotent:
 *   - Re-enqueue branch: pushing a fresh `receipt_pdf_render` outbox
 *     row is safe — the worker checks `receipt_pdf_status='rendered'`
 *     first and no-ops on the second tick.
 *   - Permanent-failure branch: dedupe by
 *     `audit_log.payload->>'invoice_id'` so dual-fire (or repeated
 *     ticks after a row reaches 3 attempts) emits the alert at most
 *     once per invoice.
 *
 * Recovery sweep for the async receipt-PDF pipeline (T166):
 *   - The webhook commits the invoice as `paid` + enqueues a
 *     `receipt_pdf_render` outbox row.
 *   - The outbox dispatcher invokes `renderReceiptPdf`. On failure
 *     (PDF render exception, Blob upload exception), the use-case
 *     calls `applyReceiptPdfFailure` in a separate tx — bumping
 *     `receipt_pdf_render_attempts` and flipping
 *     `receipt_pdf_status='failed'`.
 *   - The dispatcher also retries the outbox row via the standard
 *     ladder, but those retries can themselves run out (max attempts).
 *     This cron is the LAST-RESORT recovery: it scans for invoices
 *     stuck in `failed`, re-enqueues a fresh outbox row when there is
 *     budget left (`render_attempts < 3`), and otherwise emits a
 *     `pdf_render_permanently_failed` audit row to page on-call.
 *
 * Authentication: gated by `CRON_SECRET` Bearer (same convention as
 * other crons). Dev-mode accepts unauthenticated calls so an operator
 * can trigger it manually during recovery.
 *
 * Cross-tenant scope: this is a maintenance surface that walks all
 * tenants; reads bypass RLS deliberately (no `app.current_tenant`
 * set on the top-level scan), but every state-changing write rebinds
 * to the row's tenant via `runInTenant(asTenantContext(tenantId))` so
 * the outbox INSERT + audit emit stay tenant-scoped.
 *
 * Idempotency: safe to dual-fire. After re-enqueue, the row's
 * `receipt_pdf_status` flips back to `pending` (when the dispatcher
 * tick picks it up); a second cron tick won't see it under the
 * `status='failed'` filter. Permanent-failure audit emit checks for
 * an existing row first to avoid double-paging.
 *
 * Runbook: `docs/runbooks/receipt-pdf-permanently-failed.md`
 */
import { NextResponse, type NextRequest } from 'next/server';
import { and, eq, isNotNull, sql } from 'drizzle-orm';

import { db, runInTenant } from '@/lib/db';
import { verifyCronBearer } from '@/lib/cron-auth';
import { logger } from '@/lib/logger';
import { requestIdFromHeaders } from '@/lib/request-id';
import { asTenantContext } from '@/modules/tenants';
// Cross-module deep imports — documented escape hatch for cross-
// tenant ops surface (mirrors `sweep-stale-pending-refunds` pattern).
// Top-level Application use case for cross-tenant orchestration is
// out of scope; this is a maintenance path, not a user flow.
/* eslint-disable no-restricted-imports */
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { receiptPdfRenderEnqueueAdapter } from '@/modules/invoicing/infrastructure/adapters/receipt-pdf-render-enqueue-adapter';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
/* eslint-enable no-restricted-imports */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_RENDER_ATTEMPTS = 3;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);

  // R1-S2 — auth strictness mirrors outbox-dispatch: require
  // CRON_SECRET (≥16 chars) in ALL environments, no dev bypass. The
  // earlier dev-bypass branch was inconsistent with the rest of the
  // cron surface and meant a misconfigured prod could fall back to
  // the dev-mode "open" path if env reading hiccuped.
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) {
    logger.error({ requestId }, 'cron.receipt_pdf_reconcile.secret_misconfigured');
    return NextResponse.json(
      { error: 'server_misconfiguration' },
      { status: 500 },
    );
  }
  if (!verifyCronBearer(request.headers.get('authorization'), secret)) {
    logger.warn({ requestId }, 'cron.receipt_pdf_reconcile.unauthorized');
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Bulk read all `failed` invoices across tenants. RLS bypass is
  // intentional here (cross-tenant ops surface gated by CRON_SECRET).
  // Each row drives a tenant-scoped follow-up below.
  let stuckRows: Array<{
    tenantId: string;
    invoiceId: string;
    fiscalYear: number | null;
    pdfTemplateVersion: number | null;
    receiptPdfRenderAttempts: number;
    memberIdentitySnapshot: unknown;
  }> = [];
  try {
    stuckRows = await db
      .select({
        tenantId: invoices.tenantId,
        invoiceId: invoices.invoiceId,
        fiscalYear: invoices.fiscalYear,
        pdfTemplateVersion: invoices.pdfTemplateVersion,
        receiptPdfRenderAttempts: invoices.receiptPdfRenderAttempts,
        memberIdentitySnapshot: invoices.memberIdentitySnapshot,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.receiptPdfStatus, 'failed'),
          isNotNull(invoices.fiscalYear),
          isNotNull(invoices.pdfTemplateVersion),
        ),
      );
  } catch (e) {
    logger.error(
      {
        requestId,
        errKind: e instanceof Error ? e.constructor.name : 'unknown',
      },
      'cron.receipt_pdf_reconcile.scan_failed',
    );
    return NextResponse.json({ error: 'scan_failed' }, { status: 500 });
  }

  let reEnqueued = 0;
  let permanentlyFailed = 0;
  let alreadyAlerted = 0;
  let errored = 0;

  for (const row of stuckRows) {
    const recipientEmail = (() => {
      // Best-effort recipient — not load-bearing for the worker
      // (renderReceiptPdf doesn't read it), but we record one for
      // audit-trail readability + outbox UI.
      const snap = row.memberIdentitySnapshot as
        | { primary_contact_email?: string }
        | null;
      return snap?.primary_contact_email ?? 'system:reconcile@swecham.test';
    })();

    // The DB-level isNotNull filter on these two columns guarantees
    // values, but TS can't see through Drizzle's column nullability.
    if (row.fiscalYear === null || row.pdfTemplateVersion === null) {
      continue;
    }
    const fiscalYear = row.fiscalYear;
    const pdfTemplateVersion = row.pdfTemplateVersion;

    try {
      if (row.receiptPdfRenderAttempts < MAX_RENDER_ATTEMPTS) {
        // Budget remains — re-enqueue under the row's tenant
        // context so the outbox INSERT respects RLS (defense in
        // depth: the adapter doesn't filter by tenant_id, but
        // running under the right tenant slot keeps the audit
        // chain consistent).
        //
        // R4-I1 + R5-C1 — both writes (status flip + outbox INSERT)
        // MUST commit atomically. The `runInTenant` callback receives
        // a `tx` handle (it's `db.transaction(async (tx) => …)`
        // internally) — we MUST thread that tx through both writes
        // so they share one Postgres transaction. Earlier shape used
        // bare `db.update(...)` + `enqueue(null, ...)` which both
        // auto-commit independently: a crash between the two writes
        // would leave invoice flipped to 'pending' with NO outbox
        // row, and the next reconcile tick wouldn't pick it up
        // (filter is `WHERE status='failed'`) — silent data loss.
        await runInTenant(asTenantContext(row.tenantId), async (tx) => {
          await tx
            .update(invoices)
            .set({
              receiptPdfStatus: 'pending',
              receiptPdfLastError: null,
              updatedAt: sql`now()`,
            })
            .where(
              and(
                eq(invoices.tenantId, row.tenantId),
                eq(invoices.invoiceId, row.invoiceId),
                eq(invoices.receiptPdfStatus, 'failed'),
              ),
            );
          await receiptPdfRenderEnqueueAdapter.enqueue(tx, {
            tenantId: row.tenantId,
            invoiceId: row.invoiceId,
            fiscalYear,
            templateVersion: pdfTemplateVersion,
            recipientEmail,
          });
        });
        reEnqueued += 1;
        logger.warn(
          {
            requestId,
            tenantId: row.tenantId,
            invoiceId: row.invoiceId,
            attempts: row.receiptPdfRenderAttempts,
          },
          'cron.receipt_pdf_reconcile.re_enqueued',
        );
      } else {
        // R1-I2 — Dedupe + emit MUST run inside runInTenant so RLS on
        // audit_log resolves to the row's tenant. Reading audit_log
        // OUTSIDE runInTenant left `app.current_tenant` unset, which
        // (with FORCE RLS on audit_log) returned zero rows for every
        // dedupe check → we re-emitted `pdf_render_permanently_failed`
        // every 5 minutes, double-paging on-call. Both reads + writes
        // now share the same tenant context.
        const isFreshAlert = await runInTenant(
          asTenantContext(row.tenantId),
          async () => {
            const existing = await db
              .select({ id: auditLog.id })
              .from(auditLog)
              .where(
                and(
                  eq(auditLog.tenantId, row.tenantId),
                  eq(auditLog.eventType, 'pdf_render_permanently_failed'),
                  sql`${auditLog.payload}->>'invoice_id' = ${row.invoiceId}`,
                ),
              )
              .limit(1);
            if (existing.length > 0) return false;

            await f4AuditAdapter.emit(null, {
              tenantId: row.tenantId,
              requestId,
              eventType: 'pdf_render_permanently_failed',
              actorUserId: 'system:cron',
              summary: `Receipt PDF render exhausted ${MAX_RENDER_ATTEMPTS} attempts for invoice ${row.invoiceId}`,
              payload: {
                invoice_id: row.invoiceId,
                fiscal_year: row.fiscalYear,
                pdf_template_version: row.pdfTemplateVersion,
                attempts: row.receiptPdfRenderAttempts,
                source: 'cron.receipt_pdf_reconcile',
              },
            });
            return true;
          },
        );

        if (isFreshAlert) {
          permanentlyFailed += 1;
          logger.error(
            {
              requestId,
              tenantId: row.tenantId,
              invoiceId: row.invoiceId,
              attempts: row.receiptPdfRenderAttempts,
            },
            'cron.receipt_pdf_reconcile.permanently_failed',
          );
        } else {
          alreadyAlerted += 1;
        }
      }
    } catch (e) {
      errored += 1;
      logger.error(
        {
          requestId,
          tenantId: row.tenantId,
          invoiceId: row.invoiceId,
          errKind: e instanceof Error ? e.constructor.name : 'unknown',
        },
        'cron.receipt_pdf_reconcile.row_failed',
      );
    }
  }

  logger.info(
    {
      requestId,
      total: stuckRows.length,
      reEnqueued,
      permanentlyFailed,
      alreadyAlerted,
      errored,
    },
    'cron.receipt_pdf_reconcile.completed',
  );

  return NextResponse.json(
    {
      ok: true,
      total: stuckRows.length,
      reEnqueued,
      permanentlyFailed,
      alreadyAlerted,
      errored,
    },
    { status: 200 },
  );
}

