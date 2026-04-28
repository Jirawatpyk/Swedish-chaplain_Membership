/**
 * Outbox dispatcher cron (F3 US3.b.1 / T089).
 *
 * Scheduled via Vercel Cron every 60 seconds:
 *   vercel.json: { "crons": [{ "path": "/api/cron/outbox-dispatch",
 *                               "schedule": "* * * * *" }] }
 *
 * Drains `notifications_outbox` rows in `pending` status whose
 * `next_retry_at <= now()`. For each row it:
 *   1. Re-selects the row with FOR UPDATE SKIP LOCKED inside a fresh
 *      tx — this is the lock scope that prevents duplicate dispatch
 *      across concurrent cron ticks. The outer SELECT is lock-less
 *      and used only to pick candidates; the real lock lives inside
 *      the per-row tx.
 *   2. Builds the email HTML from the appropriate template based on
 *      `notification_type` + `context_data` + `locale`.
 *   3. Calls Resend via the shared `emailSender` (3-retry exponential
 *      backoff INSIDE the send — outer retry budget is the outbox
 *      attempts column).
 *   4. On success → status='sent', sent_message_id = response.id.
 *   5. On transient failure → attempts += 1, next_retry_at pushed
 *      exponentially (60s / 5m / 30m / 3h / 12h per FR-012c), last_error
 *      logged.
 *   6. On attempt == 5 failure or invalid-recipient → status='permanently_failed'
 *      + emit `email_dispatch_failed` audit event (FR-012c).
 *
 * Authentication: gated by the Vercel-provided `CRON_SECRET` env var
 * (Bearer). Dev environments allow unauthenticated manual triggers.
 *
 * Template types supported: `email_verification`, `email_change_revert`,
 * `email_verification_resent`, `member_invitation`. Unknown payloads
 * fall through as permanent failure after MAX_ATTEMPTS with an audit
 * event emission (FR-012c parity for unrenderable rows).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { and, count, eq, lt, lte, ne } from 'drizzle-orm';
import { db } from '@/lib/db';
import { verifyCronBearer } from '@/lib/cron-auth';
/* eslint-disable no-restricted-imports --
 * Cron job: direct UPDATE on `notifications_outbox` + auditLog — this
 * is the operational drain path, not a user flow. Same escape hatch
 * as /api/cron/lockout-cleanup. */
import {
  auditLog,
  notificationsOutbox,
  type NotificationsOutboxRow,
} from '@/modules/auth/infrastructure/db/schema';
/* eslint-enable no-restricted-imports */
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { outboxMetrics, invoicingMetrics } from '@/lib/metrics';
import { requestIdFromHeaders } from '@/lib/request-id';
/* eslint-disable no-restricted-imports --
 * Cron dispatcher is operational infrastructure — the same escape
 * hatch /api/cron/lockout-cleanup uses. */
import { emailSender } from '@/modules/auth/infrastructure/email/resend-client';
import { buildEmailVerificationEmail } from '@/modules/members/infrastructure/email/email-verification-email';
import { buildEmailChangeRevertEmail } from '@/modules/members/infrastructure/email/email-change-revert-email';
import type { EmailLocale } from '@/modules/members/infrastructure/email/email-verification-email';
import { buildInvitationEmail } from '@/modules/auth/infrastructure/email/invitation-email';
import { isRole } from '@/modules/auth/domain/role';
import {
  buildInvoiceAutoEmail,
  type InvoiceAutoEmailEventType,
} from '@/modules/invoicing/infrastructure/email/invoice-auto-email';
import { vercelBlobAdapter } from '@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
/* eslint-enable no-restricted-imports */
import { renderReceiptPdf, makeRenderReceiptPdfDeps } from '@/modules/invoicing';
import { runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import { sql as sqlTag } from 'drizzle-orm';

// Spec FR-012c: "≥ 5 attempts with exponential backoff 60s / 5m / 30m / 3h / 12h".
const RETRY_BACKOFF_SECONDS = [60, 300, 1_800, 10_800, 43_200] as const;
const MAX_ATTEMPTS = 5;

// R18-02 — accepted shape for `expected_pdf_sha256` in `context_data`.
// Matches `Sha256Hex.parse` in the domain value object. A malformed
// value (empty / non-hex / wrong length) drives the integrity check
// into fail-safe permanent-fail instead of silently falling through
// to unverified shipping.
const RE_SHA256 = /^[0-9a-f]{64}$/;

// Keeps the function within the Vercel 300s default timeout while giving
// comfortable headroom above expected throughput (< 50 emails/day per tenant).
const BATCH_SIZE = 50;

type Locale = EmailLocale;

function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'th' || value === 'sv';
}

interface BuiltPayload {
  subject: string;
  html: string;
  text: string;
  /**
   * FR-036 — optional file attachments. Currently populated only for
   * `invoice_voided` (VOID-stamped invoice PDF) so the member's
   * bookkeeper has a filing-complete record that matches the original
   * invoice on file.
   */
  attachments?: ReadonlyArray<{
    readonly filename: string;
    readonly content: Uint8Array;
    readonly contentType: string;
  }>;
}

/**
 * Translate an outbox row into a ready-to-send email. Returns `null`
 * when the row's notification_type + context_data do not produce a
 * renderable payload; the dispatcher then treats this as a permanent-
 * failure path with an explicit audit event so unrenderable rows do
 * not disappear silently.
 */
async function buildPayload(
  row: NotificationsOutboxRow,
  prefetchedBytes?: Uint8Array,
): Promise<BuiltPayload | null> {
  const locale: Locale = isLocale(row.locale) ? row.locale : 'en';
  const ctx = row.contextData as Record<string, unknown>;

  switch (row.notificationType) {
    case 'email_verification':
    case 'email_verification_resent': {
      const token = typeof ctx.token === 'string' ? ctx.token : '';
      if (!token) return null;
      return buildEmailVerificationEmail({
        toEmail: row.toEmail,
        token,
        locale,
      });
    }
    case 'email_change_revert': {
      const token = typeof ctx.token === 'string' ? ctx.token : '';
      const oldEmail = typeof ctx.oldEmail === 'string' ? ctx.oldEmail : '';
      const newEmail = typeof ctx.newEmail === 'string' ? ctx.newEmail : '';
      if (!token || !oldEmail || !newEmail) return null;
      return buildEmailChangeRevertEmail({
        toEmail: row.toEmail,
        oldEmail,
        newEmail,
        token,
        locale,
      });
    }
    case 'member_invitation': {
      const token = typeof ctx.token === 'string' ? ctx.token : '';
      const roleRaw = typeof ctx.role === 'string' ? ctx.role : '';
      if (!token || !roleRaw || !isRole(roleRaw)) return null;
      return buildInvitationEmail({
        toEmail: row.toEmail,
        token,
        role: roleRaw,
        locale,
      });
    }
    case 'invoice_auto_email': {
      // F4 auto-email row: context_data contains eventType +
      // pdf_blob_key (+ document_number for invoice_voided). Resolve
      // the Blob URL (stable public URL per vercel-blob-adapter.ts —
      // no TTL concerns) for the download link. For `invoice_voided`
      // specifically (FR-036) we ALSO fetch the PDF bytes and attach
      // them so the bookkeeper receives a filing-complete
      // cancellation record next to the original invoice they filed.
      const eventType = ctx.event_type as string | undefined;
      const pdfBlobKey = typeof ctx.pdf_blob_key === 'string' ? ctx.pdf_blob_key : '';
      const documentNumber =
        typeof ctx.document_number === 'string' ? ctx.document_number : undefined;
      // B-1 / FR-036 — void reason for invoice_voided body copy.
      const voidReason =
        typeof ctx.void_reason === 'string' ? ctx.void_reason : undefined;
      if (!pdfBlobKey || !isInvoiceAutoEmailEventType(eventType)) return null;
      // R-2 — external HTTP work (Blob head + fetch) happens BEFORE
      // the FOR UPDATE SKIP LOCKED tx wraps this buildPayload call.
      // The caller `dispatchOne` prefetches `prefetchedAttachmentBytes`
      // for `invoice_voided` rows outside the tx; here we only resolve
      // the download URL (`head` only) plus use the prefetched bytes
      // if present. A failure to read the URL is still a transient
      // signal — return null, the outbox retry ladder re-attempts.
      try {
        const downloadUrl = await vercelBlobAdapter.signDownloadUrl(pdfBlobKey);
        const payload = await buildInvoiceAutoEmail({
          toEmail: row.toEmail,
          eventType,
          downloadUrl,
          locale,
          ...(documentNumber ? { documentNumber } : {}),
          ...(voidReason ? { voidReason } : {}),
          // PG-2 — copy adapts based on whether the bytes are actually
          // shipped. `prefetchedBytes` is only populated when the
          // FEATURE_F4_VOID_ATTACHMENT flag is on.
          hasAttachment: eventType === 'invoice_voided' && !!prefetchedBytes,
        });
        if (eventType === 'invoice_voided' && prefetchedBytes) {
          const filenameBase = documentNumber ? documentNumber : 'invoice';
          return {
            ...payload,
            attachments: [
              {
                filename: `${filenameBase}-VOID.pdf`,
                content: prefetchedBytes,
                contentType: 'application/pdf',
              },
            ],
          };
        }
        return payload;
      } catch (blobErr) {
        // R-3 — log before returning null so ops can distinguish blob-
        // fetch failures from other render-path nulls in Vercel logs.
        logger.warn(
          { outboxRowId: row.id, err: blobErr },
          'cron.outbox_dispatch.invoice_voided.blob_url_lookup_failed',
        );
        return null;
      }
    }
    default:
      return null;
  }
}

function isInvoiceAutoEmailEventType(v: unknown): v is InvoiceAutoEmailEventType {
  return (
    v === 'invoice_issued' ||
    v === 'invoice_paid' ||
    v === 'invoice_voided' ||
    v === 'credit_note_issued' ||
    v === 'invoice_pdf_resent' ||
    v === 'receipt_pdf_resent' ||
    v === 'credit_note_pdf_resent'
  );
}

type DispatchOutcome = 'sent' | 'retried' | 'permanent' | 'skipped';

/**
 * T166-07 — Async receipt PDF render dispatcher branch.
 *
 * Routes a `notification_type='receipt_pdf_render'` outbox row to
 * the F4 `renderReceiptPdf` use-case, scoped to the row's tenant via
 * `runInTenant(payload.tenantId)` (Constitution Principle I clause 3
 * — tenant isolation MUST be applied before any per-tenant data
 * touches RLS).
 *
 * Status flips:
 *   - success → status='sent'
 *   - retryable failure (render or upload) → attempts++, exponential
 *     backoff per FR-012c
 *   - attempts >= MAX_ATTEMPTS → status='permanently_failed' + audit
 *     `pdf_render_permanently_failed` (pages on-call per
 *     `docs/runbooks/receipt-pdf-permanently-failed.md`)
 *
 * Idempotency: the use-case's own pending→rendered guard makes
 * duplicate worker runs no-ops (returns ok). At-least-once delivery
 * semantics are preserved.
 */
async function dispatchReceiptPdfRender(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  row: NotificationsOutboxRow,
  requestId: string,
  now: Date,
): Promise<DispatchOutcome> {
  if (!row.tenantId) {
    // Defensive: tenant_id is required for RLS scoping. A NULL
    // tenant_id `receipt_pdf_render` row is malformed; permanent-fail.
    await tx
      .update(notificationsOutbox)
      .set({
        status: 'permanently_failed' as const,
        attempts: row.attempts + 1,
        lastError: 'missing tenant_id',
        updatedAt: now,
      })
      .where(eq(notificationsOutbox.id, row.id));
    outboxMetrics.permanentFailure(row.notificationType, 'no_template_handler');
    return 'permanent';
  }

  const ctx = row.contextData as Record<string, unknown>;
  const invoiceId = typeof ctx.invoice_id === 'string' ? ctx.invoice_id : '';
  const fiscalYear = typeof ctx.fiscal_year === 'number' ? ctx.fiscal_year : 0;
  const templateVersion =
    typeof ctx.template_version === 'number' ? ctx.template_version : 0;

  if (!invoiceId || !fiscalYear || !templateVersion) {
    await tx
      .update(notificationsOutbox)
      .set({
        status: 'permanently_failed' as const,
        attempts: row.attempts + 1,
        lastError: 'malformed context_data',
        updatedAt: now,
      })
      .where(eq(notificationsOutbox.id, row.id));
    outboxMetrics.permanentFailure(row.notificationType, 'no_template_handler');
    return 'permanent';
  }

  // Run the worker under the row's tenant context. The use-case
  // opens its OWN tx (use-case's `withTx`) — distinct from this
  // dispatcher tx — so a render failure doesn't roll back the
  // dispatcher's outbox status update.
  //
  // review-20260428-102639.md S9 closure — defense-in-depth on
  // tenantId shape before passing to RLS context. The DB column is
  // already non-NULL TEXT, but a malformed value (e.g. data
  // corruption / row tampering / future migration regression) would
  // bind an attacker-controllable string into `app.current_tenant`.
  // Slug regex matches the tenant-creation contract (lowercase
  // alphanumeric + hyphen, 1-64 chars).
  if (!row.tenantId || !/^[a-z0-9-]{1,64}$/.test(row.tenantId)) {
    logger.error(
      {
        requestId,
        outboxRowId: row.id,
        tenantIdLen: row.tenantId?.length ?? 0,
      },
      'cron.outbox_dispatch.invalid_tenant_id',
    );
    await tx
      .update(notificationsOutbox)
      .set({
        status: 'permanently_failed' as const,
        attempts: row.attempts + 1,
        lastError: 'invalid_tenant_id',
        updatedAt: now,
      })
      .where(eq(notificationsOutbox.id, row.id));
    outboxMetrics.permanentFailure(row.notificationType, 'no_template_handler');
    return 'permanent';
  }
  const tenantCtx = asTenantContext(row.tenantId);
  const result = await runInTenant(tenantCtx, async () => {
    return renderReceiptPdf(makeRenderReceiptPdfDeps(row.tenantId!), {
      tenantId: row.tenantId!,
      invoiceId,
      fiscalYear,
      templateVersion,
      requestId,
    });
  });

  if (result.ok) {
    await tx
      .update(notificationsOutbox)
      .set({
        status: 'sent' as const,
        // No `sentMessageId` for render rows — they aren't emails. The
        // `updatedAt` + `status='sent'` pair is the canonical "row
        // complete" marker used by the existing dispatcher.
        updatedAt: now,
      })
      .where(eq(notificationsOutbox.id, row.id));
    return 'sent';
  }

  // Failure path: bump attempts + decide retry vs permanent.
  const nextAttempt = row.attempts + 1;
  // review-20260428-102639.md S8 closure — `data_corruption` is
  // deterministic (missing/unparseable receipt_document_number_raw);
  // retry will produce identical failure. Short-circuit to permanent.
  const isDataCorruption = result.error.code === 'data_corruption';
  const isPermanent = isDataCorruption || nextAttempt >= MAX_ATTEMPTS;
  const reason =
    'reason' in result.error
      ? (result.error as { reason?: string }).reason ?? result.error.code
      : result.error.code;

  if (isPermanent) {
    await tx
      .update(notificationsOutbox)
      .set({
        status: 'permanently_failed' as const,
        attempts: nextAttempt,
        lastError: String(reason).slice(0, 500),
        updatedAt: now,
      })
      .where(eq(notificationsOutbox.id, row.id));
    // review-20260428-102639.md H3 closure — emit via f4AuditAdapter
    // so retention_years is enforced explicitly by adapter logic
    // (f4RetentionFor) instead of relying on the DB-level DEFAULT 5.
    // Pre-fix used `tx.insert(auditLog)` directly which bypassed the
    // T135 retention enforcement and would silently regress if the
    // retention map ever changed.
    await f4AuditAdapter.emit(tx, {
      eventType: 'pdf_render_permanently_failed',
      actorUserId: 'system:cron',
      summary: `receipt_pdf_render row ${row.id} permanently failed (${reason})`,
      requestId,
      tenantId: row.tenantId,
      payload: {
        outbox_row_id: row.id,
        invoice_id: invoiceId,
        attempts: nextAttempt,
        reason,
      },
    } as Parameters<typeof f4AuditAdapter.emit>[1]);
    // Use `max_retries` for the bounded enum — the underlying reason
    // is preserved in `last_error` on the outbox row + the audit
    // `pdf_render_permanently_failed` payload above for forensics.
    outboxMetrics.permanentFailure(row.notificationType, 'max_retries');
    return 'permanent';
  }

  // Retryable failure: exponential backoff per FR-012c.
  const backoffSeconds =
    RETRY_BACKOFF_SECONDS[Math.min(nextAttempt - 1, RETRY_BACKOFF_SECONDS.length - 1)] ?? 60;
  const nextRetryAt = new Date(now.getTime() + backoffSeconds * 1000);
  await tx
    .update(notificationsOutbox)
    .set({
      attempts: nextAttempt,
      nextRetryAt,
      lastError: String(reason).slice(0, 500),
      updatedAt: now,
    })
    .where(eq(notificationsOutbox.id, row.id));
  // No `retry` metric — the existing outboxMetrics surface only
  // tracks permanent failures + stuck rows. Render-attempt counters
  // live in the audit log payload (see T166-14 observability docs).
  return 'retried';
}

/**
 * Process one outbox row inside its own db.transaction(). Re-selects
 * the row with FOR UPDATE SKIP LOCKED so only one cron tick ever sends
 * a given row, even when Vercel Cron overlaps ticks at high load.
 *
 * Returns 'skipped' when another tick already claimed the row.
 */
async function dispatchOne(
  rowId: string,
  requestId: string,
): Promise<DispatchOutcome> {
  // R-2 — prefetch the `invoice_voided` PDF attachment bytes OUTSIDE
  // the db.transaction() so the Blob head+fetch latency does not
  // extend the FOR UPDATE SKIP LOCKED window (which also covers the
  // Resend send). A lock-less peek determines whether prefetch is
  // needed; the tx does its own re-select with the lock so a
  // concurrent tick winning the race simply wastes the prefetch.
  let prefetchedBytes: Uint8Array | undefined;
  // R17-02 — when the void two-phase commit's Phase 2 (post-commit Blob
  // overwrite) fails, the Blob still holds the ORIGINAL un-stamped
  // invoice bytes but audit + outbox row reflect the NEW sha256. A
  // naïve dispatcher would ship those un-stamped bytes as the
  // "cancellation" attachment — a bookkeeper would receive what looks
  // like a perfectly valid invoice attached to a cancellation notice.
  // If `expected_pdf_sha256` is present in ctx, we hash the prefetched
  // bytes and permanently-fail the row on mismatch instead of
  // shipping. Mismatch is rare (Phase 2 retry path handles the common
  // case) but the blast radius of shipping wrong bytes is high.
  let integrityViolation: 'attachment_sha_mismatch' | null = null;
  try {
    const [peek] = await db
      .select({
        notificationType: notificationsOutbox.notificationType,
        contextData: notificationsOutbox.contextData,
      })
      .from(notificationsOutbox)
      .where(eq(notificationsOutbox.id, rowId))
      .limit(1);
    if (peek && peek.notificationType === 'invoice_auto_email') {
      const ctx = peek.contextData as Record<string, unknown>;
      const eventType = ctx.event_type;
      const pdfBlobKey = typeof ctx.pdf_blob_key === 'string' ? ctx.pdf_blob_key : '';
      // R18-02 — tightened validation: the raw value must be a
      // 64-char lowercase-hex sha256 to count as "present". A stray
      // empty string / malformed digest would otherwise pass the old
      // typeof-string check and drive a misleading "mismatch" audit.
      // Split detection so we can flag malformed vs mismatch distinctly
      // while keeping the fail-safe outcome (both → permanent-fail).
      const expectedShaRaw =
        typeof ctx.expected_pdf_sha256 === 'string' ? ctx.expected_pdf_sha256 : null;
      const expectedSha =
        expectedShaRaw !== null && RE_SHA256.test(expectedShaRaw) ? expectedShaRaw : null;
      const expectedShaMalformed = expectedShaRaw !== null && expectedSha === null;
      // PG-2 gate — only prefetch bytes when attachment is enabled by
      // DPA clearance. When the flag is OFF, the dispatcher ships a
      // link-only email (FR-036 partial) and never transfers PDF
      // bytes to Resend.
      if (
        eventType === 'invoice_voided' &&
        pdfBlobKey &&
        env.features.f4VoidAttachment
      ) {
        if (expectedShaMalformed) {
          // R18-02 — present but malformed. Skip the prefetch entirely
          // and route into the permanent-fail branch: shipping without
          // verification would defeat the whole purpose of the check.
          // Logged at warn (not error) to distinguish malformed-
          // enqueue (bug upstream) from real content mismatch.
          logger.warn(
            {
              outboxRowId: rowId,
              expectedShaRawLength: expectedShaRaw?.length ?? 0,
            },
            'cron.outbox_dispatch.invoice_voided.expected_sha_malformed',
          );
          integrityViolation = 'attachment_sha_mismatch';
        } else {
          const bytes = await vercelBlobAdapter.downloadBytes(pdfBlobKey);
          if (expectedSha) {
            // Hex-encoded lower-case sha256 — matches Sha256Hex branded
            // shape emitted by the render adapter.
            const actualSha = createHash('sha256').update(bytes).digest('hex');
            if (actualSha !== expectedSha) {
              logger.error(
                {
                  outboxRowId: rowId,
                  expectedSha,
                  actualShaPrefix: actualSha.slice(0, 16),
                },
                'cron.outbox_dispatch.invoice_voided.attachment_sha_mismatch',
              );
              integrityViolation = 'attachment_sha_mismatch';
            } else {
              prefetchedBytes = bytes;
            }
          } else {
            prefetchedBytes = bytes;
          }
        }
      }
    }
  } catch (prefetchErr) {
    // R-3 — prefetch failure is a transient signal; log and continue
    // into the tx without bytes. `buildPayload` will return null and
    // the row retries per the outbox backoff ladder.
    logger.warn(
      { outboxRowId: rowId, err: prefetchErr },
      'cron.outbox_dispatch.invoice_voided.prefetch_bytes_failed',
    );
  }

  return db.transaction(async (tx) => {
    // R18-04 — single `now` for every status-flip branch in this tx
    // (previously the integrity-violation branch declared its own
    // `integrityNow` because this declaration used to live later in
    // the callback). Hoisted so all UPDATE `updated_at` + `next_retry_at`
    // writes share a consistent wall-clock timestamp per tick.
    const now = new Date();

    // Re-select inside the tx with the lock. If another tick holds
    // the lock OR the row is no longer pending, return 'skipped'.
    const [row] = await tx
      .select()
      .from(notificationsOutbox)
      .where(
        and(
          eq(notificationsOutbox.id, rowId),
          eq(notificationsOutbox.status, 'pending'),
        ),
      )
      .for('update', { skipLocked: true })
      .limit(1);

    if (!row) return 'skipped';

    // T166-07 — async receipt PDF render branch. The dispatcher
    // routes `receipt_pdf_render` rows to the F4 `renderReceiptPdf`
    // use-case INSIDE `runInTenant(payload.tenantId)` so RLS scoping
    // applies (Constitution Principle I clause 3). Render task is
    // NOT an email — skip the buildPayload/Resend pipeline entirely.
    if (row.notificationType === 'receipt_pdf_render') {
      return await dispatchReceiptPdfRender(tx, row, requestId, now);
    }

    // T166-09 — async receipt PDF gate for `invoice_paid` emails.
    // When `record-payment` runs under `asyncReceiptPdf=true`, the
    // email row commits inside the same tx as the `paid` flip + a
    // `receipt_pdf_status='pending'` invoice. The PDF bytes don't
    // exist yet; the link in the email would 404. Gate the send on
    // `receipt_pdf_status='rendered'` and re-queue (without bumping
    // attempts) when still pending — the next cron tick re-evaluates
    // after the worker uploads.
    if (
      row.notificationType === 'invoice_auto_email' &&
      (row.contextData as Record<string, unknown>).depends_on_receipt_pdf === true
    ) {
      const ctx = row.contextData as Record<string, unknown>;
      const invoiceId = typeof ctx.invoice_id === 'string' ? ctx.invoice_id : null;
      if (invoiceId && row.tenantId) {
        const tenantCtx = asTenantContext(row.tenantId);
        const [invRow] = await runInTenant(tenantCtx, async () =>
          tx.execute<{ receipt_pdf_status: string | null }>(
            sqlTag`SELECT receipt_pdf_status FROM invoices
                   WHERE tenant_id = ${row.tenantId} AND invoice_id = ${invoiceId}
                   LIMIT 1`,
          ),
        );
        // R1-I1 — fail CLOSED, not OPEN. If we cannot prove
        // status === 'rendered', we MUST hold the email.
        //
        // R2-I-2 — distinguish two skip reasons:
        //   (a) invRow VISIBLE + status='pending'/'failed' → legitimate
        //       wait; push back 60s + DO NOT bump attempts (preserves
        //       retry budget for after the worker finishes).
        //   (b) invRow UNDEFINED → pathological (invoice hard-deleted
        //       or RLS-mismatch). Push back AND bump attempts so the
        //       row exits via the standard max-retries → permanent_fail
        //       ladder instead of skip-looping forever.
        if (invRow === undefined) {
          await tx
            .update(notificationsOutbox)
            .set({
              attempts: row.attempts + 1,
              nextRetryAt: new Date(now.getTime() + 60_000),
              lastError:
                'receipt_pdf_gate_skip:invoice_not_visible — invoice row missing under tenant RLS scope (deleted or tenant_id mismatch)',
              updatedAt: now,
            })
            .where(eq(notificationsOutbox.id, row.id));
          return 'skipped';
        }
        // R3-I1 — distinguish 'pending' (legitimate wait) from 'failed'
        // (terminal). When the reconcile cron exhausts max-retries the
        // invoice's `receipt_pdf_status` stays at 'failed' forever; if
        // we treated 'failed' as "still rendering" the email row would
        // skip-loop every minute indefinitely, never bumping `attempts`,
        // never reaching `permanently_failed`. Split the branches so a
        // 'failed' receipt drains the email row via the normal max-
        // retries → permanent-fail ladder (operator gets a single page
        // instead of a forever-stuck queue).
        if (invRow.receipt_pdf_status === 'failed') {
          await tx
            .update(notificationsOutbox)
            .set({
              attempts: row.attempts + 1,
              nextRetryAt: new Date(now.getTime() + 60_000),
              lastError:
                'receipt_pdf_gate_skip:pdf_render_failed — receipt PDF is in terminal failed state; email cannot ship',
              updatedAt: now,
            })
            .where(eq(notificationsOutbox.id, row.id));
          return 'skipped';
        }
        if (invRow.receipt_pdf_status !== 'rendered') {
          // Legitimate wait — receipt still rendering ('pending'); do
          // NOT burn an attempt. Worker will flip to 'rendered' on
          // success and the next dispatcher tick releases the gate.
          await tx
            .update(notificationsOutbox)
            .set({
              nextRetryAt: new Date(now.getTime() + 60_000),
              updatedAt: now,
            })
            .where(eq(notificationsOutbox.id, row.id));
          return 'skipped';
        }
        // status === 'rendered' → fall through to dispatch.
      } else {
        // Defensive: gate flag set but no invoice_id / tenant_id —
        // malformed context_data. Bump attempts so it exits via
        // permanent-fail (would otherwise skip-loop forever).
        await tx
          .update(notificationsOutbox)
          .set({
            attempts: row.attempts + 1,
            nextRetryAt: new Date(now.getTime() + 60_000),
            lastError:
              'receipt_pdf_gate_skip:malformed_context — depends_on_receipt_pdf set but invoice_id/tenant_id missing',
            updatedAt: now,
          })
          .where(eq(notificationsOutbox.id, row.id));
        return 'skipped';
      }
    }

    // R17-02 — integrity violation detected during prefetch: do NOT
    // ship a link-only fallback (the link points at the same Blob key
    // whose bytes failed verification, so link-only would deliver the
    // same wrong content). Permanently fail immediately with a
    // distinct reason so ops can re-render via an admin action once
    // the underlying Blob is healthy.
    if (integrityViolation) {
      const nextAttempt = row.attempts + 1;
      await tx
        .update(notificationsOutbox)
        .set({
          status: 'permanently_failed' as const,
          attempts: nextAttempt,
          lastError: integrityViolation,
          updatedAt: now,
        })
        .where(eq(notificationsOutbox.id, row.id));
      await tx.insert(auditLog).values({
        eventType: 'email_dispatch_failed',
        actorUserId: 'system:cron',
        summary: `outbox row ${row.id} permanently failed (${integrityViolation})`,
        requestId,
        tenantId: row.tenantId,
        payload: {
          outbox_row_id: row.id,
          notification_type: row.notificationType,
          attempts: nextAttempt,
          reason: integrityViolation,
        },
      });
      if (row.notificationType === 'invoice_auto_email' && row.tenantId) {
        await tx.insert(auditLog).values({
          eventType: 'auto_email_delivery_failed',
          actorUserId: 'system:cron',
          summary: `F4 auto-email outbox row ${row.id} permanently failed (${integrityViolation})`,
          requestId,
          tenantId: row.tenantId,
          payload: {
            outbox_row_id: row.id,
            notification_type: row.notificationType,
            attempts: nextAttempt,
            reason: integrityViolation,
          },
        });
      }
      outboxMetrics.permanentFailure(row.notificationType, integrityViolation);
      if (row.notificationType === 'invoice_auto_email') {
        invoicingMetrics.autoEmailBounce(integrityViolation);
      }
      return 'permanent';
    }

    const payload = await buildPayload(row, prefetchedBytes);

    if (!payload) {
      const nextAttempt = row.attempts + 1;
      const isPermanent = nextAttempt >= MAX_ATTEMPTS;

      if (isPermanent) {
        await tx
          .update(notificationsOutbox)
          .set({
            attempts: nextAttempt,
            status: 'permanently_failed' as const,
            lastError: 'no_template_handler',
            updatedAt: now,
          })
          .where(eq(notificationsOutbox.id, row.id));

        // S1 — audit emission parity with send-failure permanent path.
        // Emitted inside the tx so it commits atomically with the status
        // flip. `auditLog.tenantId` is nullable (schema.ts:256) — for
        // cross-tenant platform rows (F1 invitation flow with
        // tenant_id=null) we still insert the audit row with tenantId
        // null so compliance evidence lives in the append-only table
        // rather than only in pino logs.
        await tx.insert(auditLog).values({
          eventType: 'email_dispatch_failed',
          actorUserId: 'system:cron',
          summary: `outbox row ${row.id} permanently failed (no_template_handler) after ${nextAttempt} attempts`,
          requestId,
          tenantId: row.tenantId,
          payload: {
            outbox_row_id: row.id,
            notification_type: row.notificationType,
            attempts: nextAttempt,
            reason: 'no_template_handler',
          },
        });
        // T106 — dual-emit the F4-specific `auto_email_delivery_failed`
        // event alongside the generic `email_dispatch_failed` when the
        // failed row is an F4 invoice_auto_email. Lets F4 audit-coverage
        // queries filter by a single event type without having to
        // join on `payload->>'notification_type'`. Emitted inside the
        // same tx so both audit rows + the status flip commit atomically.
        if (row.notificationType === 'invoice_auto_email' && row.tenantId) {
          await tx.insert(auditLog).values({
            eventType: 'auto_email_delivery_failed',
            actorUserId: 'system:cron',
            summary: `F4 auto-email outbox row ${row.id} permanently failed (no_template_handler) after ${nextAttempt} attempts`,
            requestId,
            tenantId: row.tenantId,
            payload: {
              outbox_row_id: row.id,
              notification_type: row.notificationType,
              attempts: nextAttempt,
              reason: 'no_template_handler',
            },
          });
        }
        outboxMetrics.permanentFailure(
          row.notificationType,
          'no_template_handler',
        );
        if (row.notificationType === 'invoice_auto_email') {
          invoicingMetrics.autoEmailBounce('no_template_handler');
        }
        return 'permanent';
      }

      // Same exponential schedule as the send-failure path (FR-012c):
      // 60s / 5m / 30m / 3h / 12h. Keeps retry cadence uniform across
      // transient-template and transient-send failures.
      const noTplBackoffSeconds =
        RETRY_BACKOFF_SECONDS[
          Math.min(nextAttempt - 1, RETRY_BACKOFF_SECONDS.length - 1)
        ]!;
      await tx
        .update(notificationsOutbox)
        .set({
          attempts: nextAttempt,
          nextRetryAt: new Date(now.getTime() + noTplBackoffSeconds * 1000),
          lastError: 'no_template_handler',
          updatedAt: now,
        })
        .where(eq(notificationsOutbox.id, row.id));
      return 'retried';
    }

    // NOTE: Resend send happens INSIDE the tx. The tx holds a row-level
    // lock until commit — two concurrent ticks cannot both send the
    // same row. The tradeoff is that the tx stays open for the duration
    // of the HTTP call to Resend (typically < 2 s). At our current
    // throughput (< 50 emails/day) this is acceptable; if it becomes a
    // bottleneck we can switch to a claim+release pattern where the tx
    // only claims the row and the send happens outside.
    const result = await emailSender.send({
      to: row.toEmail,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
      // FR-036 — attach VOID-stamped PDF when the payload builder
      // supplied attachments (today: invoice_voided only).
      ...(payload.attachments && payload.attachments.length > 0
        ? { attachments: payload.attachments }
        : {}),
    });

    if (result.ok) {
      await tx
        .update(notificationsOutbox)
        .set({
          status: 'sent',
          sentMessageId: result.value.messageId,
          updatedAt: now,
        })
        .where(eq(notificationsOutbox.id, row.id));
      return 'sent';
    }

    const nextAttempt = row.attempts + 1;
    const isPermanent =
      nextAttempt >= MAX_ATTEMPTS || result.error.code === 'invalid-recipient';

    if (isPermanent) {
      await tx
        .update(notificationsOutbox)
        .set({
          status: 'permanently_failed',
          attempts: nextAttempt,
          lastError: result.error.message,
          updatedAt: now,
        })
        .where(eq(notificationsOutbox.id, row.id));

      logger.error(
        {
          requestId,
          outboxRowId: row.id,
          tenantId: row.tenantId,
          notificationType: row.notificationType,
          attempts: nextAttempt,
          errorCode: result.error.code,
        },
        'cron.outbox_dispatch.permanent_failure',
      );

      // S1 — always insert audit inside tx (tenantId nullable in schema).
      // Cross-tenant platform rows (F1 invitation, tenant_id=null) now
      // land in auditLog for compliance parity with tenant-scoped rows.
      await tx.insert(auditLog).values({
        eventType: 'email_dispatch_failed',
        actorUserId: 'system:cron',
        summary: `outbox row ${row.id} permanently failed after ${nextAttempt} attempts`,
        requestId,
        tenantId: row.tenantId,
        payload: {
          outbox_row_id: row.id,
          notification_type: row.notificationType,
          attempts: nextAttempt,
          last_error: result.error.message,
        },
      });
      // T106 — dual-emit F4-specific `auto_email_delivery_failed` for
      // invoice_auto_email rows (same rationale as the no_template_handler
      // path above). Requires a non-null tenantId because the F4 audit
      // type is tenant-scoped; F4 rows always carry one, but guard for
      // defensive symmetry with the generic emit.
      if (row.notificationType === 'invoice_auto_email' && row.tenantId) {
        await tx.insert(auditLog).values({
          eventType: 'auto_email_delivery_failed',
          actorUserId: 'system:cron',
          summary: `F4 auto-email outbox row ${row.id} permanently failed after ${nextAttempt} attempts`,
          requestId,
          tenantId: row.tenantId,
          payload: {
            outbox_row_id: row.id,
            notification_type: row.notificationType,
            attempts: nextAttempt,
            last_error: result.error.message,
            reason:
              result.error.code === 'invalid-recipient'
                ? 'invalid_recipient'
                : 'max_retries',
          },
        });
      }
      outboxMetrics.permanentFailure(
        row.notificationType,
        result.error.code === 'invalid-recipient'
          ? 'invalid_recipient'
          : 'max_retries',
      );
      // T113 — F4 auto-email bounce counter. Fires alongside the
      // generic outbox counter above so F4 observability dashboards
      // can alert on bounce rate without grep'ing a notification_type
      // label off the generic counter.
      if (row.notificationType === 'invoice_auto_email') {
        invoicingMetrics.autoEmailBounce(
          result.error.code === 'invalid-recipient'
            ? 'invalid_recipient'
            : 'max_retries',
        );
      }
      return 'permanent';
    }

    const backoffSeconds =
      RETRY_BACKOFF_SECONDS[
        Math.min(nextAttempt - 1, RETRY_BACKOFF_SECONDS.length - 1)
      ]!;
    const nextRetryAt = new Date(now.getTime() + backoffSeconds * 1000);

    await tx
      .update(notificationsOutbox)
      .set({
        attempts: nextAttempt,
        nextRetryAt,
        lastError: result.error.message,
        updatedAt: now,
      })
      .where(eq(notificationsOutbox.id, row.id));

    logger.warn(
      {
        requestId,
        outboxRowId: row.id,
        tenantId: row.tenantId,
        attempts: nextAttempt,
        backoffSeconds,
        errorCode: result.error.code,
      },
      'cron.outbox_dispatch.retry_scheduled',
    );
    return 'retried';
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);

  // R7-W8 + R8-T1 refinement — CRON_SECRET is validated as required
  // (min 16 chars) at boot by `src/lib/env.ts`, so the "secret is
  // missing" branch is impossible in prod. We compare against
  // `process.env.CRON_SECRET` (not the cached `env.cron.secret`) so
  // integration tests can rotate the secret mid-suite via
  // `process.env.CRON_SECRET = 'new'` — the cached env object is
  // immutable after boot. If the env var IS unset (impossible in
  // prod), the comparison to `Bearer undefined` still triggers 401
  // for any caller — no dev fallback, no unauthenticated drain.
  // R15-04 — explicit misconfiguration guard replaces the old `?? ''`
  // fallback. `src/lib/env.ts` validates `CRON_SECRET` as
  // `z.string().min(16)` at boot, so the app refuses to start on miss.
  // If the env var were ever hot-unset in a live process (unit tests
  // rotate via `process.env.CRON_SECRET = 'new'`), fail loud with a 500
  // instead of silently comparing against `Bearer ` (7 chars).
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) {
    logger.error(
      { requestId },
      'cron.outbox_dispatch.secret_misconfigured',
    );
    return NextResponse.json(
      { error: 'server_misconfiguration' },
      { status: 500 },
    );
  }
  if (!verifyCronBearer(request.headers.get('authorization'), secret)) {
    logger.warn({ requestId }, 'cron.outbox_dispatch.unauthorized');
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const now = new Date();

  // R7-B4 fix — FEATURE_F4_INVOICING kill-switch containment. When F4
  // is disabled the dispatcher MUST NOT ship `invoice_auto_email`
  // rows (which carry Blob download URLs to tax PDFs) while still
  // draining F1 outbox rows. The previous proxy-layer gate on
  // `/api/cron/auto-email-dispatch` was a path-mismatch (that route
  // never existed) — flipping the kill-switch therefore had no
  // containment power. Filter at query time so rows are skipped
  // cleanly without racking up per-row retries or errors.
  const baseReadyFilters = [
    eq(notificationsOutbox.status, 'pending'),
    lte(notificationsOutbox.nextRetryAt, now),
  ];
  if (!env.features.f4Invoicing) {
    baseReadyFilters.push(ne(notificationsOutbox.notificationType, 'invoice_auto_email'));
  }
  // R1-I3 — kill-switch parity for the T166 async render branch.
  // When `FEATURE_F5_ASYNC_RECEIPT_PDF` is off, the dispatcher must
  // also stop picking up `receipt_pdf_render` rows. Without this
  // filter, flipping the flag false (rollback path) wouldn't stop
  // the worker — the dispatcher would keep invoking `renderReceiptPdf`
  // on rows that were enqueued before the flip, defeating the
  // kill-switch's purpose. The rows themselves remain in the outbox
  // for manual recovery (see runbook receipt-pdf-async-rollback.md).
  if (!env.features.f5AsyncReceiptPdf) {
    baseReadyFilters.push(
      ne(notificationsOutbox.notificationType, 'receipt_pdf_render'),
    );
  }

  // Lock-less candidate pick. Real per-row lock happens inside dispatchOne.
  const ready = await db
    .select({ id: notificationsOutbox.id })
    .from(notificationsOutbox)
    .where(and(...baseReadyFilters))
    .limit(BATCH_SIZE);

  // Level 2 — stuck-rows check: pending rows whose next_retry_at is > 30 min
  // overdue indicate the cron has been down or lost CRON_SECRET. Runs BEFORE
  // the `ready.length === 0` early return because the exact failure mode it
  // is designed to catch (cron hasn't dispatched anything) produces zero
  // ready rows. Wrapped in try/catch so an observability failure never
  // breaks the dispatch summary.
  try {
    const stuckThreshold = new Date(Date.now() - 30 * 60_000);
    const [stuckResult] = await db
      .select({ stuckCount: count() })
      .from(notificationsOutbox)
      .where(
        and(
          eq(notificationsOutbox.status, 'pending'),
          lt(notificationsOutbox.nextRetryAt, stuckThreshold),
        ),
      );
    const stuckCount = stuckResult?.stuckCount ?? 0;
    if (stuckCount > 0) {
      outboxMetrics.stuckRows(stuckCount);
      logger.error(
        { requestId, stuckCount },
        'cron.outbox_dispatch.stuck_rows_detected',
      );
    }
  } catch (healthErr) {
    logger.warn(
      { requestId, err: healthErr },
      'cron.outbox_dispatch.health_check_failed',
    );
  }

  if (ready.length === 0) {
    return NextResponse.json({ ok: true, dispatched: 0 }, { status: 200 });
  }

  let sent = 0;
  let retried = 0;
  let permanent = 0;
  let skipped = 0;

  for (const { id } of ready) {
    try {
      const outcome = await dispatchOne(id, requestId);
      if (outcome === 'sent') sent += 1;
      else if (outcome === 'retried') retried += 1;
      else if (outcome === 'permanent') permanent += 1;
      else skipped += 1;
    } catch (txError) {
      // Tx failed (connection loss, deadlock). Row stays pending and a
      // future tick will retry via the normal SKIP LOCKED path.
      logger.error(
        { requestId, outboxRowId: id, err: txError },
        'cron.outbox_dispatch.tx_failed',
      );
    }
  }

  logger.info(
    { requestId, inspected: ready.length, sent, retried, permanent, skipped },
    'cron.outbox_dispatch.done',
  );
  return NextResponse.json(
    { ok: true, inspected: ready.length, sent, retried, permanent, skipped },
    { status: 200 },
  );
}

// POST mirror so alternative schedulers that use POST also work.
export const POST = GET;
