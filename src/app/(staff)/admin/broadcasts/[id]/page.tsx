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
import { makeGetBroadcastDeps, parseBroadcastId } from '@/modules/broadcasts';
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
