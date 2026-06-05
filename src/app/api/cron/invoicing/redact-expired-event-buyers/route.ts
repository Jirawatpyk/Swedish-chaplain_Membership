/**
 * POST `/api/cron/invoicing/redact-expired-event-buyers`
 *
 * 054-event-fee-invoices (Task 15) — 10-year PII-redaction sweep for
 * NON-MEMBER event-invoice buyers.
 *
 * Thai RD §87/3 + §86/10 require a §86/4 tax document be retained for 10
 * years. Once that window elapses, GDPR Art. 5(1)(e) (storage limitation)
 * + Art. 17 (erasure) require the personal data on it be minimised. For a
 * non-member event invoice the buyer PII lives in `member_identity_snapshot`
 * (member_id IS NULL). This sweep tombstones JUST that column — preserving
 * every financial / §87-numbering field, which the §87/3 statutory record
 * and any later RD audit still need — and emits `event_buyer_pii_redacted`.
 *
 * ── PDF blob purge (complete erasure, RETRYABLE) ───────────────────────────
 * The buyer PII is ALSO printed on the issued §86/4 tax-document PDF(s) (name
 * / address / tax_id), stored in Vercel Blob at a public, non-expiring URL.
 * Tombstoning only the DB snapshot would leave that PII readable on the blob
 * — INCOMPLETE erasure (GDPR Art. 17). So this cron also DELETES the invoice
 * PDF blob and (if present) the receipt PDF blob. The `pdf_blob_key` /
 * `receipt_pdf_blob_key` COLUMNS are intentionally left intact: they are the
 * document reference for the §87/3 statutory record; only the underlying BYTES
 * are erased. The invoice-detail Blob-miss recovery path already tolerates a
 * dangling key.
 *
 * RETRYABILITY (code-review HIGH-3): the old design tombstoned + committed,
 * THEN purged best-effort — a crash between commit and purge stranded PII PDF
 * bytes on Blob FOREVER, because the row was now tombstoned
 * (`legal_name='[REDACTED]'`) and the old predicate excluded it from the next
 * sweep. The fix is a nullable `pii_blob_purged_at` marker column:
 *   (a) in the tenant tx under the GUC: tombstone the snapshot via an UPDATE that
 *       `RETURNING`s the row, then emit the audit + queue the purge ONLY when the
 *       UPDATE actually changed a row (round-2 FIX 1 — audit-once is gated on the
 *       UPDATE's real effect, not the stale SELECT flag, so a concurrent instance
 *       that already tombstoned the row cannot trigger a duplicate audit); commit.
 *       For a tombstoned row with ZERO blob keys, stamp `pii_blob_purged_at` in
 *       this SAME tx (round-2 FIX 2 — the purge is trivially complete; nothing to
 *       erase) so the marker is never left permanently NULL.
 *   (b) purge the blob bytes best-effort (each delete try/catch'd, logged with
 *       errKind only + the error metric on failure) — only for rows WITH keys.
 *   (c) ONLY on a fully successful purge of ALL the row's blob keys, set
 *       `pii_blob_purged_at = now()` via a SEPARATE UPDATE under the GUC.
 * A crash before (c) leaves `pii_blob_purged_at` NULL → the next sweep
 * RE-SELECTS the row (redacted-but-unpurged arm of the predicate) and retries
 * the purge. The snapshot is already tombstoned, so the retry re-exposes no PII
 * and does NOT re-emit the audit; the purge simply lands on a later tick.
 *
 * Membership invoices are NOT touched here: their buyer is a real F3 member
 * (member_id IS NOT NULL) whose PII retention is governed by the F3/F9
 * member-lifecycle + GDPR-export surfaces, not this event-buyer sweeper.
 *
 * ── Immutability-trigger bypass (the sensitive part) ───────────────────────
 * `invoices_enforce_immutability` (migration 0019, amended 0205 + 0206) locks
 * `member_identity_snapshot` + `pii_blob_purged_at` the moment a row leaves
 * `draft`. To erase the buyer PII this cron sets the session GUC
 * `app.allow_pii_redaction = 'true'` via `SET LOCAL` INSIDE its per-tenant tx
 * (auto-resets at tx end, mirroring the `app.current_tenant` GUC in
 * `runInTenant`). The amended trigger then permits ONLY `member_identity_snapshot`
 * AND `pii_blob_purged_at` to change under that GUC — every other snapshot /
 * numbering / financial / event-discriminator column still RAISES if touched.
 * No other code path sets this GUC.
 *
 * ── Idempotency ────────────────────────────────────────────────────────────
 * The eligibility predicate matches a row that is EITHER still un-redacted
 * (`legal_name <> '[REDACTED]'`) OR redacted-but-purge-incomplete
 * (`legal_name = '[REDACTED]' AND pii_blob_purged_at IS NULL` with a blob key
 * still present). A fully-redacted-and-purged row (`pii_blob_purged_at` set)
 * is excluded, so re-running the cron only ever (re-)processes work that is not
 * yet complete. retry-OFF on cron-job.org: the daily tick is the natural retry.
 *
 * ── Cross-tenant sweep ─────────────────────────────────────────────────────
 * Iterates every tenant that has invoice settings (the only tenants that can
 * own event invoices), mirroring the F5 `sweep-stale-pending-refunds`
 * tenant-list pattern. The cross-tenant SELECT of the tenant list bypasses
 * RLS intentionally (owner role, no `app.current_tenant` set) — it is a
 * maintenance path gated by `CRON_SECRET`, not a user request. Each tenant's
 * data mutation runs inside `runInTenant` so RLS + the tenant GUC apply.
 *
 * Authentication: Bearer `CRON_SECRET` (constant-time `verifyCronBearer`),
 * matching the sibling F4 `sweep-stale-pending-refunds` cron.
 *
 * Returns 200 `{ ok, redactedCount, tenantsSwept, tenantsErrored }` (NO PII).
 * Per-tenant failures are logged + skipped so one bad tenant cannot block the
 * rest; the audit/metric trail (not the HTTP status) is the alerting anchor.
 *
 * Runbook: `docs/runbooks/cron-jobs.md` § F4 redact-expired-event-buyers.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { verifyCronBearer } from '@/lib/cron-auth';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { invoicingMetrics } from '@/lib/metrics';
import { requestIdFromHeaders } from '@/lib/request-id';
import { asTenantContext } from '@/modules/tenants';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
import { vercelBlobAdapter } from '@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter';

// Cron path: cross-tenant read + per-tenant mutation. No top-level
// Application use case exists for cross-tenant orchestration — it is a
// maintenance path, not a user flow. Documented escape hatch (mirrors the
// sibling F5 sweep-stale-pending-refunds + F6 pseudonymise-eventcreate crons).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const ROUTE = '/api/cron/invoicing/redact-expired-event-buyers';

/** PII fields tombstoned on the buyer snapshot. NAMES only — never values. */
const REDACTED_FIELDS = [
  'legal_name',
  'address',
  'primary_contact_name',
  'primary_contact_email',
  'tax_id',
] as const;

interface EligibleRow {
  readonly invoice_id: string;
  /** Issued invoice PDF blob key (prints the buyer PII). May be null pre-render. */
  readonly pdf_blob_key: string | null;
  /** Issued receipt PDF blob key — null for combined-mode / unpaid rows. */
  readonly receipt_pdf_blob_key: string | null;
  /**
   * Whether this row was ALREADY tombstoned on a prior pass (the redacted-but-
   * unpurged retry case). When true the cron skips the tombstone UPDATE + audit
   * and only retries the blob purge. Derived from the snapshot's `legal_name`.
   */
  readonly already_tombstoned: boolean;
}

/**
 * A row whose tx committed and whose PDF bytes still need erasing. `keys` are
 * the blob keys to purge; `tombstonedThisRun` LABELS the purge for observability
 * (true → bytes erased on the same pass the snapshot was tombstoned; false → a
 * retry purging an already-tombstoned row whose prior purge crashed). Audit-once
 * is enforced UPSTREAM by the `already_tombstoned` branch, NOT by this field.
 * The post-commit purge stamps `pii_blob_purged_at` only when
 * every key in `keys` is successfully deleted.
 */
interface PurgeWorkItem {
  readonly invoiceId: string;
  readonly keys: readonly string[];
  readonly tombstonedThisRun: boolean;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);

  if (!verifyCronBearer(request.headers.get('authorization'), env.cron.secret)) {
    logger.warn({ requestId, route: ROUTE }, 'cron.redact_expired_event_buyers.unauthorized');
    return NextResponse.json({ error: { code: 'unauthorized' } }, { status: 401 });
  }

  // Tenant list — every tenant that has invoice settings can own event
  // invoices. Reads bypass tenant RLS (owner role, no app.current_tenant)
  // intentionally — cross-tenant ops surface gated by CRON_SECRET.
  let tenantSlugs: string[] = [];
  try {
    const rows = (await db.execute(sql`
      SELECT tenant_id FROM tenant_invoice_settings
    `)) as unknown as Array<{ tenant_id: string }>;
    tenantSlugs = rows.map((r) => r.tenant_id);
  } catch (e) {
    // errKind/constructor name only — a Postgres error message can carry SQL
    // fragments / column values (forbidden-fields hygiene).
    logger.error(
      { requestId, route: ROUTE, errKind: e instanceof Error ? e.constructor.name : 'unknown' },
      'cron.redact_expired_event_buyers.tenant_list_failed',
    );
    return NextResponse.json({ error: { code: 'tenant_list_failed' } }, { status: 500 });
  }

  let redactedCount = 0;
  let tenantsSwept = 0;
  let tenantsErrored = 0;

  for (const tenantSlug of tenantSlugs) {
    try {
      const ctx = asTenantContext(tenantSlug);
      const redactedResult = await runInTenant(ctx, async (tx) => {
        // Authorise the buyer-PII tombstone + purge-marker writes for THIS tx
        // only. SET LOCAL auto-resets at tx end; the amended trigger (0205 +
        // 0206) lets ONLY member_identity_snapshot AND pii_blob_purged_at change
        // while this is 'true'.
        await tx.execute(sql`SET LOCAL app.allow_pii_redaction = 'true'`);

        // Eligible (HIGH-3 retryable predicate): a non-member event invoice,
        // issued (any non-draft), older than 10 years, with a non-null buyer
        // snapshot, that is EITHER
        //   (1) still UN-REDACTED (legal_name <> '[REDACTED]'), OR
        //   (2) REDACTED-BUT-PURGE-INCOMPLETE (legal_name = '[REDACTED]' AND
        //       pii_blob_purged_at IS NULL with a blob key still present) — i.e.
        //       a row whose DB tombstone committed on a prior pass but whose PDF
        //       byte purge did not complete (crash / Blob outage between commit
        //       and purge). `already_tombstoned` distinguishes the two so case
        //       (2) skips the tombstone UPDATE + audit and only retries the purge.
        // A fully-redacted-and-purged row (pii_blob_purged_at set) is excluded.
        // RLS scopes the read to this tenant (chamber_app role + GUC).
        //
        // FIX 1 (round-2) — `FOR UPDATE SKIP LOCKED`: under two concurrent cron
        // instances the eligibility windows can overlap. Locking the selected
        // rows FOR UPDATE and SKIPPING any a sibling instance already holds means
        // each row is processed by AT MOST ONE instance per tick — eliminating
        // the contended path entirely. The tombstone UPDATE's RETURNING-rowcount
        // gate below is the authoritative audit-once guarantee even if a row is
        // somehow seen by both (SKIP LOCKED is the cheap first line of defence).
        const eligible = (await tx.execute(sql`
          SELECT
            invoice_id,
            pdf_blob_key,
            receipt_pdf_blob_key,
            (member_identity_snapshot->>'legal_name') = '[REDACTED]' AS already_tombstoned
          FROM invoices
          WHERE invoice_subject = 'event'
            AND member_id IS NULL
            AND status <> 'draft'
            AND issue_date < (now() - interval '10 years')::date
            AND member_identity_snapshot IS NOT NULL
            AND (
              (member_identity_snapshot->>'legal_name') <> '[REDACTED]'
              OR (
                (member_identity_snapshot->>'legal_name') = '[REDACTED]'
                AND pii_blob_purged_at IS NULL
                AND (pdf_blob_key IS NOT NULL OR receipt_pdf_blob_key IS NOT NULL)
              )
            )
          FOR UPDATE SKIP LOCKED
        `)) as unknown as EligibleRow[];

        let tenantRedacted = 0;
        // Work items whose PDF BYTES must be erased once this tx commits.
        // Collected inside the tx (so we only ever purge bytes for a tombstone
        // that is durable) and acted on AFTER commit — never inside the tx, so a
        // blob-side hiccup can't dirty / roll back the DB erasure.
        const purgeWork: PurgeWorkItem[] = [];
        for (const row of eligible) {
          // The issued tax-document PDF(s) carry the same buyer PII in print.
          // Collect their KEYS (receipt key may be null) — these are the bytes
          // to erase + the forensic record of WHAT was purged. Keys are path
          // segments (tenant/doc-id), not PII values.
          const blobKeys = [row.pdf_blob_key, row.receipt_pdf_blob_key].filter(
            (k): k is string => Boolean(k),
          );

          if (row.already_tombstoned) {
            // RETRY case (HIGH-3): the DB tombstone committed on a prior pass;
            // only the blob purge is outstanding. Do NOT re-run the tombstone
            // UPDATE and do NOT re-emit the audit (audit-once across retries) —
            // just queue the purge so a later successful delete stamps the marker.
            if (blobKeys.length > 0) {
              purgeWork.push({ invoiceId: row.invoice_id, keys: blobKeys, tombstonedThisRun: false });
            }
            continue;
          }

          const redactedAt = new Date().toISOString();

          // Tombstone the buyer PII, preserving the jsonb STRUCTURE so the
          // non-draft snapshot CHECK (member_identity_snapshot IS NOT NULL)
          // still holds and the doc-type contract shape is intact. Only the
          // five PII fields change; every financial/numbering/event column is
          // left untouched (the trigger enforces this under the GUC).
          //
          // LOW-13 (tombstone shape): the `|| jsonb_build_object(...)` merge
          // OVERWRITES exactly the five REDACTED_FIELDS keys on the existing
          // buyer object and adds none others, so the result stays a flat jsonb
          // object with the same key set — schema-valid for the doc-type
          // contract (legal_name/address/primary_contact_name string, tax_id
          // nullable, primary_contact_email string) and non-null (the non-draft
          // snapshot CHECK still holds). `tax_id` → SQL NULL becomes a jsonb
          // null; `primary_contact_email` → '' keeps it a string. The shape is
          // fixed (no dynamic keys), so no runtime assertion is warranted.
          //
          // FIX 1 (round-2) — audit-once is gated on this UPDATE's ACTUAL effect,
          // NOT the stale SELECT flag. `RETURNING invoice_id` reports whether the
          // row was actually changed: the predicate `legal_name <> '[REDACTED]'`
          // means a concurrent instance that already tombstoned this row makes the
          // UPDATE match 0 rows. We emit the audit + queue the purge ONLY when
          // THIS instance tombstoned the row (exactly one row returned). When 0
          // rows come back, a sibling instance already owns the row's lifecycle —
          // SKIP the audit and SKIP queueing the purge (no double-audit, no
          // double-purge-queue). Atomic with the audit because both run in this tx.
          const tombstoned = (await tx.execute(sql`
            UPDATE invoices
            SET member_identity_snapshot = member_identity_snapshot
              || jsonb_build_object(
                   'legal_name', '[REDACTED]',
                   'address', '[REDACTED]',
                   'primary_contact_name', '[REDACTED]',
                   'primary_contact_email', '',
                   'tax_id', NULL
                 )
            WHERE invoice_id = ${row.invoice_id}
              AND (member_identity_snapshot->>'legal_name') <> '[REDACTED]'
            RETURNING invoice_id
          `)) as unknown as Array<{ invoice_id: string }>;

          if (tombstoned.length !== 1) {
            // A concurrent instance tombstoned this row between our SELECT and
            // this UPDATE (the SELECT flag was stale). That instance owns the
            // audit + purge for this row — do NOT emit a duplicate audit and do
            // NOT queue the purge here. (The FOR UPDATE SKIP LOCKED above makes
            // this branch rare; this rowcount gate is the authoritative guard.)
            continue;
          }

          // FIX 2 (round-2) — zero-blob rows: a redacted row with NO blob keys
          // has nothing to purge, so its redaction is COMPLETE the instant the
          // snapshot is tombstoned. Stamp `pii_blob_purged_at = now()` in THIS
          // GUC tx (the marker column is exempt under the redaction GUC —
          // migration 0206) so the row is not left with a permanently-NULL marker
          // (the retry predicate requires a blob key, so a NULL-marker zero-blob
          // row would never be re-selected). Rows WITH blob keys keep the marker
          // NULL until the post-commit purge succeeds (handled by purgeWork below).
          //
          // DEFENCE-IN-DEPTH NOTE: under the CURRENT schema this branch is not
          // reachable for an ISSUED event invoice — the CHECK constraint
          // `invoices_non_draft_has_snapshots` (migrations 0024 + 0203) requires
          // `pdf_blob_key IS NOT NULL` on every non-draft invoice, so `blobKeys`
          // always carries at least the invoice-PDF key. The guard is kept so the
          // marker stays correct IF that invariant is ever relaxed (constraint
          // change, manual data fix, or a future doc-kind that skips PDF render).
          if (blobKeys.length === 0) {
            await tx.execute(sql`
              UPDATE invoices
              SET pii_blob_purged_at = now()
              WHERE invoice_id = ${row.invoice_id}
                AND pii_blob_purged_at IS NULL
            `);
          }

          // Audit in the SAME tx as the UPDATE — atomic: a rollback removes
          // both. Emitted ONLY when THIS instance freshly tombstoned the row
          // (rowcount gate above), never on a retry or a lost concurrency race —
          // so the audit lands EXACTLY ONCE per row across all passes/instances.
          // NON-timeline payload (no member_id; the row has none). Field NAMES
          // only — never the erased PII values. 10y retention is applied by the
          // adapter via F4_AUDIT_RETENTION_YEARS.
          await f4AuditAdapter.emit(tx, {
            eventType: 'event_buyer_pii_redacted',
            // `audit_log.actor_user_id` is `text NOT NULL`; the sweeper has no
            // human actor → the project-wide cron sentinel (matches every other
            // cron route's emit).
            actorUserId: 'system:cron',
            // Static, PII-value-free summary — the invoice_id + erased blob
            // keys live in the structured payload. Hygiene convention for a
            // PII-erasure route: keep `summary` free of per-row values.
            summary: 'event_buyer_pii_redacted',
            payload: {
              invoice_id: row.invoice_id,
              redacted_at: redactedAt,
              redacted_fields: [...REDACTED_FIELDS],
              // KEYS to erase alongside the DB tombstone (not URLs → not PII) —
              // the forensic proof the blob purge is part of this erasure. The
              // bytes are purged AFTER commit; on a crash the purge retries on a
              // later tick without re-emitting this audit.
              blob_purged_keys: blobKeys,
              reason: 'retention_10y_elapsed',
              route: ROUTE,
            },
            tenantId: tenantSlug,
            requestId,
          });

          // Queue the post-commit byte purge ONLY for rows WITH blob keys. A
          // zero-blob row already had its `pii_blob_purged_at` stamped inline
          // above (FIX 2) — its redaction is complete, nothing to purge — so it
          // is intentionally NOT queued here.
          if (blobKeys.length > 0) {
            purgeWork.push({ invoiceId: row.invoice_id, keys: blobKeys, tombstonedThisRun: true });
          }
          tenantRedacted += 1;
        }
        return { tenantRedacted, purgeWork };
      });

      const { tenantRedacted: redactedThisTenant, purgeWork } = redactedResult;

      // Erase the PDF BYTES AFTER the tx committed, then — and ONLY on a fully
      // successful purge of every key for the row — stamp `pii_blob_purged_at`
      // in a SEPARATE GUC-gated UPDATE so the marker is durable proof the bytes
      // are gone. Best-effort + non-fatal per delete: the DB tombstone
      // (authoritative copy) is already durable, so a blob failure must NOT undo
      // it — log (errKind only, NO PII) + bump the error metric, then carry on.
      // If ANY key fails (or the marker UPDATE fails), `pii_blob_purged_at`
      // stays NULL → the NEXT sweep RE-SELECTS this row (redacted-but-unpurged
      // arm) and retries the purge. No PII is re-exposed (snapshot already
      // tombstoned) and the audit is NOT re-emitted (already_tombstoned branch).
      for (const { invoiceId, keys, tombstonedThisRun } of purgeWork) {
        let allPurged = true;
        for (const key of keys) {
          try {
            await vercelBlobAdapter.delete(key);
          } catch (e) {
            allPurged = false;
            invoicingMetrics.eventBuyerPiiRedacted('error', tenantSlug);
            logger.error(
              {
                requestId,
                route: ROUTE,
                tenantId: tenantSlug,
                invoiceId,
                errKind: e instanceof Error ? e.constructor.name : 'unknown',
              },
              'cron.redact_expired_event_buyers.blob_delete_failed',
            );
          }
        }

        if (!allPurged) {
          // Leave pii_blob_purged_at NULL → retried on the next tick.
          continue;
        }

        // Every byte for this row is gone — stamp the completion marker so the
        // row is no longer re-selected. Separate tx so a marker-UPDATE failure
        // (rare) also leaves the row eligible for a clean retry rather than
        // poisoning the whole tenant pass.
        try {
          await runInTenant(ctx, async (tx) => {
            await tx.execute(sql`SET LOCAL app.allow_pii_redaction = 'true'`);
            await tx.execute(sql`
              UPDATE invoices
              SET pii_blob_purged_at = now()
              WHERE invoice_id = ${invoiceId}
                AND tenant_id = ${tenantSlug}
                AND pii_blob_purged_at IS NULL
            `);
          });
          // Observability (R1): label the completed purge so an operator can
          // tell a same-pass erase from a retry that recovered a previously
          // crashed redaction (the HIGH-3 crash-between-commit-and-purge case).
          logger.info(
            {
              requestId,
              route: ROUTE,
              tenantId: tenantSlug,
              invoiceId,
              purgeKind: tombstonedThisRun ? 'fresh' : 'retry',
            },
            'cron.redact_expired_event_buyers.blob_purged',
          );
        } catch (e) {
          invoicingMetrics.eventBuyerPiiRedacted('error', tenantSlug);
          logger.error(
            {
              requestId,
              route: ROUTE,
              tenantId: tenantSlug,
              invoiceId,
              errKind: e instanceof Error ? e.constructor.name : 'unknown',
            },
            'cron.redact_expired_event_buyers.purge_marker_failed',
          );
        }
      }

      tenantsSwept += 1;
      redactedCount += redactedThisTenant;
      invoicingMetrics.eventBuyerPiiRedacted(
        redactedThisTenant > 0 ? 'redacted' : 'swept_zero',
        tenantSlug,
      );
      if (redactedThisTenant > 0) {
        logger.warn(
          { requestId, route: ROUTE, tenantId: tenantSlug, redacted: redactedThisTenant },
          'cron.redact_expired_event_buyers.tenant_redacted',
        );
      }
    } catch (e) {
      tenantsErrored += 1;
      invoicingMetrics.eventBuyerPiiRedacted('error', tenantSlug);
      logger.error(
        {
          requestId,
          route: ROUTE,
          tenantId: tenantSlug,
          errKind: e instanceof Error ? e.constructor.name : 'unknown',
        },
        'cron.redact_expired_event_buyers.tenant_threw',
      );
    }
  }

  logger.info(
    { requestId, route: ROUTE, tenantsTotal: tenantSlugs.length, tenantsSwept, tenantsErrored, redactedCount },
    'cron.redact_expired_event_buyers.completed',
  );

  // Per cron-route convention (docs/runbooks/cron-jobs.md): per-tenant
  // failures degrade to `tenantsErrored > 0` in a 200 body; only scan-level
  // failures (auth, tenant-list query) return non-200. Alerting binds to the
  // `invoicing_event_buyer_pii_redacted_total{outcome=error}` counter.
  return NextResponse.json(
    { ok: true, redactedCount, tenantsSwept, tenantsErrored },
    { status: 200 },
  );
}
