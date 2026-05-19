import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { getLocale, getTranslations } from 'next-intl/server';
import { logger } from '@/lib/logger';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { StatusBadge } from '@/components/broadcast/admin/status-badge';
import { ReviewActions } from '@/components/broadcast/admin/review-actions';
import { ManagerReadonlyBanner } from '@/components/broadcast/admin/manager-readonly-banner';
import { AuditTimeline } from '@/components/broadcast/admin/audit-timeline';
import {
  BatchBreakdown,
  type BatchBreakdownRow,
  type BatchStatusForUi,
} from '@/components/broadcast/admin/batch-breakdown';
import {
  isF71aUs1Enabled,
  makeGetBroadcastDeps,
  MANUAL_RETRY_BUDGET,
  parseBroadcastId,
} from '@/modules/broadcasts';
import { makeDrizzleBatchManifestsRepo } from '@/modules/broadcasts/infrastructure/drizzle-batch-manifests-repo';
import { runInTenant } from '@/lib/db';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { dompurifySanitizer } from '@/modules/broadcasts';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.broadcasts.review');
  return { title: t('title') };
}

export default async function AdminBroadcastDetailPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const t = await getTranslations('admin.broadcasts.review');
  const tActor = await getTranslations('admin.broadcasts.queue.actorRole');
  const tSegment = await getTranslations('admin.broadcasts.review.segmentType');
  const session = await requireSession('staff');
  const isReadOnlyManager = session.user.role === 'manager';

  const { id } = await params;
  const parsedId = parseBroadcastId(id);
  if (!parsedId.ok) {
    notFound();
  }

  const tenant = resolveTenantFromRequest();
  const deps = makeGetBroadcastDeps(tenant.slug);
  const broadcast = await deps.broadcastsRepo.findById(tenant.slug, parsedId.value);
  if (broadcast === null) {
    notFound();
  }

  // Member display name
  const memberRows = (await runInTenant(tenant, async (tx) =>
    tx.execute(sql`
      SELECT company_name FROM members
      WHERE tenant_id = ${tenant.slug}
        AND member_id = ${broadcast.requestedByMemberId}
      LIMIT 1
    `),
  )) as unknown as Array<{ company_name: string }>;
  const memberDisplayName =
    memberRows[0]?.company_name ?? broadcast.requestedByMemberId;

  const locale = await getLocale();
  // H2 UX hardening — pin `timeZone: 'Asia/Bangkok'` so admin sees
  // Bangkok wall-time regardless of the server / browser TZ. Without
  // this, Vercel functions in `sin1` would format as Singapore-local
  // (+8) and a UTC dev environment would format as +0, drifting from
  // the contract the queue + schedule picker advertise.
  const fmt = new Intl.DateTimeFormat(
    locale === 'th' ? 'th-TH-u-ca-buddhist' : locale,
    { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' },
  );

  // UX I14 — defence-in-depth: re-sanitise stored bodyHtml at render
  // time. The body was already sanitised at submit (sanitize-html.ts)
  // but a future migration loosening at-submit rules MUST NOT widen
  // the trust boundary. Sanitising twice is cheap + idempotent.
  // IMP-3 (round-3) — sanitiser failure returns a sentinel so staff
  // sees an explicit warning panel + Approve is blocked, not an empty
  // body indistinguishable from a whitespace-only draft.
  const sanitisedBody = renderTimeSanitise(broadcast.bodyHtml);

  // F7.1a Phase 3 T049 + T061 — load per-batch manifests when US1
  // pagination feature is enabled. When OFF: skip the DB query
  // entirely (avoids surfacing legacy batch rows from a prior on/off
  // toggle) and hide the BatchBreakdown surface. F7 MVP single-
  // audience broadcasts dispatched while US1 is off would have NO
  // manifests anyway — the gate is defence-in-depth.
  //
  // Phase 3F.8 (F-14 fix) — loadBatchBreakdownRows returns null on
  // load failure (was empty array). Null is rendered as an inline
  // error banner below + skips the BatchBreakdown component (avoids
  // hiding the Retry/Accept-Partial actions for partially_sent state
  // behind a silent "not split" placeholder).
  const f71aUs1On = isF71aUs1Enabled();
  const batchManifests = f71aUs1On
    ? await loadBatchBreakdownRows(tenant.slug, broadcast.broadcastId)
    : [];
  const batchLoadFailed = batchManifests === null;
  const manualRetryRemaining = Math.max(
    0,
    MANUAL_RETRY_BUDGET - broadcast.manualRetryCount,
  );

  return (
    <DetailContainer>
      {/* B3 UX hardening — wrap the status badge in `role="status"` so
          assistive tech announces the new state when admin approves /
          rejects / cancels and the page server-refreshes. Sonner toast
          already provides ephemeral feedback; this announces the
          structural truth-of-record change too. */}
      <PageHeader
        title={broadcast.subject}
        subtitle={`${memberDisplayName} · ${t('subtitle')}`}
        badge={
          <span role="status" aria-live="polite">
            <StatusBadge status={broadcast.status} />
          </span>
        }
      />
      {isReadOnlyManager ? <ManagerReadonlyBanner /> : null}

      <section
        aria-label={t('title')}
        className="rounded-md border bg-muted/20 p-4"
      >
        {/* B1 UX hardening — proper `<dl>/<dt>/<dd>` semantics so the
            label↔value pairs are announced as a unit (WCAG 1.3.1
            meaningful sequence). Replaces the previous double-`<p>`
            structure where SR users heard two unrelated paragraphs. */}
        <dl className="grid gap-3 sm:grid-cols-2">
          <Field label={t('fields.submittedBy')} value={memberDisplayName} />
          <Field
            label={t('fields.actorRole')}
            value={tActor(broadcast.actorRole)}
          />
          <Field
            label={t('fields.submittedAt')}
            value={
              broadcast.submittedAt !== null
                ? fmt.format(broadcast.submittedAt)
                : '—'
            }
          />
          <Field
            label={t('fields.scheduledFor')}
            value={
              broadcast.scheduledFor !== null
                ? fmt.format(broadcast.scheduledFor)
                : '—'
            }
          />
          {/* B2 UX hardening — segmentType was rendered as the raw enum
              (`all_members` etc.); resolve through i18n so EN/TH/SV all
              show a human label. */}
          <Field
            label={t('fields.segment')}
            value={tSegment(broadcast.segmentType as Parameters<typeof tSegment>[0])}
          />
          <Field
            label={t('fields.recipientCount')}
            value={String(broadcast.estimatedRecipientCount)}
          />
        </dl>
      </section>

      <section
        aria-label={t('fields.body')}
        className="rounded-md border bg-background p-4"
      >
        <h3 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
          {t('fields.body')}
        </h3>
        {sanitisedBody.error ? (
          <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <p className="font-medium">{t('bodyRenderFailedTitle')}</p>
            <p className="text-xs">{t('bodyRenderFailedHint')}</p>
          </div>
        ) : (
          <div
            className="prose prose-sm dark:prose-invert max-w-none"
            // Defence-in-depth: re-sanitised at render time (UX I14).
            dangerouslySetInnerHTML={{ __html: sanitisedBody.html }}
          />
        )}
      </section>

      <AuditTimeline tenantId={tenant.slug} broadcastId={broadcast.broadcastId as string} />

      {/* F7.1a Phase 3 T049 — per-batch breakdown surface. Only renders
          when the broadcast was split into multiple Resend audiences
          (batches.length > 0) OR the broadcast is in a F7.1a-relevant
          status (partially_sent / sending — admin needs visibility
          into in-flight batches). Component shows "not split" fallback
          for F7 MVP single-audience broadcasts. T061: entire surface
          hidden when US1 flag is off. */}
      {f71aUs1On && batchLoadFailed ? (
        // Phase 3F.8 (F-14 fix) — explicit error panel instead of
        // silent "not split" placeholder. Caller sees the failure
        // + a refresh hint; ops sees the underlying error in the
        // `admin.broadcasts.detail.batch_load_failed` log line.
        <section
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
        >
          <p className="font-semibold">
            Per-batch breakdown temporarily unavailable
          </p>
          <p className="mt-1 text-destructive/80">
            We couldn&apos;t load the batch list. Refresh the page in a moment.
            Operators have been alerted via the structured log.
          </p>
        </section>
      ) : null}
      {f71aUs1On && !batchLoadFailed ? (
        <BatchBreakdown
          broadcastId={broadcast.broadcastId as unknown as string}
          broadcastStatus={broadcast.status}
          manualRetryRemaining={manualRetryRemaining}
          batches={batchManifests as ReadonlyArray<BatchBreakdownRow>}
          defaultOpen={
            broadcast.status === 'partially_sent' ||
            broadcast.status === 'partial_delivery_accepted'
          }
        />
      ) : null}

      {broadcast.status === 'submitted' && !isReadOnlyManager && !sanitisedBody.error ? (
        <div className="flex justify-end">
          <ReviewActions broadcastId={broadcast.broadcastId as string} />
        </div>
      ) : null}
    </DetailContainer>
  );
}

/**
 * Render-time sanitisation helper (UX I14 + IMP-3 round-3).
 *
 * Returns a sentinel `{html, error}` so the caller can distinguish a
 * legitimately-empty body from a sanitiser failure — the latter shows
 * a `role="alert"` warning panel and BLOCKS the Approve button so staff
 * doesn't approve content they couldn't render safely.
 */
function renderTimeSanitise(html: string): {
  readonly html: string;
  readonly error: boolean;
} {
  try {
    return { html: dompurifySanitizer.sanitize(html), error: false };
  } catch (e) {
    logger.error(
      { err: e instanceof Error ? e.message : String(e) },
      'admin.broadcasts.detail.render_sanitise_failed',
    );
    return { html: '', error: true };
  }
}

/**
 * F7.1a Phase 3 T049 — load batch_manifests + map to the
 * BatchBreakdown UI row shape. Empty array means this broadcast was
 * not split into batches (F7 MVP single-audience path).
 *
 * Returns plain JSON-serialisable rows so the Server Component → Client
 * Component prop pipe doesn't carry branded types (BroadcastId etc.)
 * across the boundary.
 */
async function loadBatchBreakdownRows(
  tenantSlug: string,
  broadcastId: import('@/modules/broadcasts').BroadcastId,
): Promise<ReadonlyArray<BatchBreakdownRow> | null> {
  try {
    const repo = makeDrizzleBatchManifestsRepo(tenantSlug);
    const manifests = await repo.findByBroadcast(
      tenantSlug as never,
      broadcastId,
    );
    return manifests.map((m) => ({
      batchManifestId: m.id,
      batchIndex: m.batchIndex,
      recipientRangeStart: m.recipientRangeStart,
      recipientRangeEnd: m.recipientRangeEnd,
      recipientCount: m.recipientCount,
      status: m.status as BatchStatusForUi,
      dispatchedAt: m.dispatchedAt !== null ? m.dispatchedAt.toISOString() : null,
      retryCount: m.retryCount,
      deliveredCount: m.deliveredCount,
      bouncedCount: m.bouncedCount,
      complainedCount: m.complainedCount,
      unsubscribedCount: m.unsubscribedCount,
    }));
  } catch (e) {
    logger.error(
      { err: e instanceof Error ? e.message : String(e), tenantSlug },
      'admin.broadcasts.detail.batch_load_failed',
    );
    // Phase 3F.8 (F-14 fix) — surface load failure to the caller via
    // a sentinel `null` instead of silent "not split" fallback empty
    // array. Previously fail-open hid the BatchBreakdown entirely
    // for `partially_sent` broadcasts → admin lost access to Retry +
    // Accept-Partial without any visible signal. Caller renders an
    // inline error panel when null + broadcast is in a state where
    // batches matter.
    return null;
  }
}

function Field({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): React.ReactElement {
  // B1 UX hardening — `<dl>` parent, so each Field is a `<div>` wrapping
  // a `<dt>`/`<dd>` pair. Avoids exposing this Field as a list-item to
  // SR users (which a bare `<dt>` outside `<dl>` would do).
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 text-sm">{value}</dd>
    </div>
  );
}
