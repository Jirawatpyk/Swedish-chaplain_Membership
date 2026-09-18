/**
 * F7 US3 T133 — Member broadcast detail page.
 *
 * Spec authority: spec.md US3 AS3 (delivery breakdown — delivered /
 * bounced / complained counts) + AS5 (cross-member probe → 404 + audit).
 *
 * Layout: `DetailContainer`. Read-only post-submit view. Uses the
 * `getMemberBroadcast` use-case which:
 *   - Returns ok if the requesting member owns the broadcast
 *   - Emits `broadcast_cross_member_probe` audit + returns
 *     `broadcast.not_found` if a different member owns it
 *   - Returns `broadcast.not_found` if the broadcast doesn't exist
 *
 * In all "not found" paths the route surfaces 404 (Next.js `notFound()`)
 * — anti-enumeration; the route does NOT distinguish between absent
 * row and cross-member probe.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { ArrowLeft } from 'lucide-react';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { getBroadcastStatusBadgeProps } from '@/components/broadcast/status-badge-mapping';
import {
  PreviewSurface,
  type PreviewState,
} from '@/components/broadcast/use-preview-html';
import { makeRenderBroadcastPreviewDeps } from '@/lib/broadcast-brand-deps';
import { isLocale } from '@/i18n/config';
import { cn } from '@/lib/utils';
import { logger } from '@/lib/logger';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  getMemberBroadcast,
  makeGetMemberBroadcastDeps,
  parseBroadcastId,
  renderBroadcastPreview,
} from '@/modules/broadcasts';
import { getDateFormatLocale } from '@/lib/format-date-localised';
import { env } from '@/lib/env';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { randomUUID } from 'node:crypto';
import { CancelBroadcastAction } from '@/components/broadcast/cancel-broadcast-action';

/* The detail page is per-(tenant, member, broadcastId) — caching across
 * users doesn't apply, and the route depends on the member-scoped
 * `runInTenant` lookup. Force dynamic rendering so `notFound()` returns
 * a true HTTP 404 (Next.js 16 sets static-cache responses to 200 even
 * when the rendered body is the not-found UI; AS5 spec mandates 404). */
export const dynamic = 'force-dynamic';

/**
 * F119 T141 — the read-back frame is taller than the compose pane's 420 px
 * (`preview-pane.tsx`): this screen has the full 72 rem column to itself and
 * the member is reading, not typing beside it. Fixed, so the frame scrolls
 * internally instead of growing the page.
 */
const DETAIL_PREVIEW_FRAME_HEIGHT = 560;

/**
 * F119 T141 (US6-AS2, FR-049) — the body the member reads back is the REAL
 * email: the same server-side renderer the preview route drives
 * (`src/lib/broadcasts-preview-route.ts`), handed to the shared
 * `PreviewSurface`, which puts it in a sandboxed `<iframe srcdoc>` — never a
 * `dangerouslySetInnerHTML` of the stored body into this page's own DOM.
 *
 * Every failure degrades to the surface's translated error state: a brand-read
 * or sanitiser outage must not 404/500 a page whose subject, status and
 * delivery numbers are all still readable.
 *
 * PR-1 renders the broadcast RECORD's own content. "the latest **sent**
 * version while awaiting the member" reads `broadcast_versions` (migration
 * `0305`) and lands with T141a in PR-2 (plan Amendment 5).
 */
async function renderStoredBody(args: {
  readonly tenantSlug: string;
  readonly broadcastId: string;
  readonly subject: string;
  readonly bodyHtml: string;
  readonly locale: string;
}): Promise<PreviewState> {
  try {
    const { tenantDisplayName, ...deps } = await makeRenderBroadcastPreviewDeps(
      args.tenantSlug as never,
    );
    const result = await renderBroadcastPreview(deps, {
      tenantId: args.tenantSlug as never,
      tenantDisplayName,
      subject: args.subject,
      bodyHtml: args.bodyHtml,
      locale: isLocale(args.locale) ? args.locale : 'en',
      surface: 'member',
    });
    if (!result.ok) {
      logger.warn(
        {
          tenantId: args.tenantSlug,
          broadcastId: args.broadcastId,
          reason: result.error.kind,
        },
        'broadcasts.detail_page.body_render_failed',
      );
      return { status: 'error' };
    }
    return { status: 'ready', html: result.value.html };
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        tenantId: args.tenantSlug,
        broadcastId: args.broadcastId,
      },
      'broadcasts.detail_page.body_render_unexpected_error',
    );
    return { status: 'error' };
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('portal.broadcasts.detail');
  return { title: t('title') };
}

export default async function BroadcastDetailPage(props: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await props.params;
  const session = await requireSession('member');
  const tenant = resolveTenantFromRequest();

  const membersDeps = buildMembersDeps(tenant);
  const memberLookup = await membersDeps.memberRepo.findByLinkedUserId(tenant, session.user.id);
  if (!memberLookup.ok) {
    // 404 covers both "user has no member row" (legitimate) and "DB
    // outage" (incident). Discriminate via the error code so a real
    // outage is logged rather than masked as a routine not-found —
    // anti-enumeration response stays the same either way.
    if (memberLookup.error.code !== 'repo.not_found') {
      logger.error(
        {
          err: memberLookup.error,
          tenantId: tenant.slug,
          userId: session.user.id,
        },
        'broadcasts.detail_page.member_lookup_unexpected_error',
      );
    }
    return notFound();
  }
  const memberId = memberLookup.value.memberId;

  // Validate ID shape early — invalid UUID = not found (no audit
  // emission; we cannot probe a non-existent row by an invalid id).
  // Log at debug so a bot probing malformed IDs is observable in
  // dashboards as a `bad_id_shape` probe-rate (correlates with the
  // `not_found` enumeration log emitted by the use-case).
  const parsed = parseBroadcastId(id);
  if (!parsed.ok) {
    logger.debug(
      {
        tenantId: tenant.slug,
        memberId,
        rawId: id,
        userId: session.user.id,
      },
      'broadcasts.detail_page.invalid_id_shape',
    );
    return notFound();
  }

  const result = await getMemberBroadcast(makeGetMemberBroadcastDeps(tenant.slug), {
    memberId,
    broadcastId: parsed.value,
    actorUserId: session.user.id,
    requestId: randomUUID(),
  });
  if (!result.ok) return notFound();

  const { broadcast, delivery } = result.value;

  const t = await getTranslations('portal.broadcasts.detail');
  const tStatus = await getTranslations('portal.broadcasts.list.status');
  const locale = await getLocale();
  const dateFormatter = new Intl.DateTimeFormat(getDateFormatLocale(locale), {
    dateStyle: 'medium',
    timeStyle: 'short',
    // Tenant-TZ pin (#315 follow-up, server-UTC display class) — matches
    // the admin broadcast detail's H2 Bangkok pin; canonical tenant TZ.
    timeZone: env.tenant.timezone,
  });

  const previewState = await renderStoredBody({
    tenantSlug: tenant.slug,
    broadcastId: broadcast.broadcastId as string,
    subject: broadcast.subject,
    bodyHtml: broadcast.bodyHtml,
    locale,
  });

  return (
    <DetailContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />

      <Link
        href="/portal/benefits?tab=broadcasts"
        className={buttonVariants({ variant: 'ghost', size: 'sm' })}
      >
        <ArrowLeft className="mr-1 h-4 w-4" aria-hidden="true" />
        {t('back')}
      </Link>

      <Card role="region" aria-labelledby="broadcast-detail-fields-heading">
        {/* The subject value is the card's title (and its accessible
            region name); "Subject" is a small overline label so the value
            reads as the dominant element rather than being subordinate to
            its own label (UX R2-I3 — the text-h4 label outweighed the 16px
            value).

            F119 T141 — the title moved into `CardHeader` and carries the
            portal's card-heading treatment: a REAL `<h2>` with the
            `CardTitle` font classes, never the shadcn `CardTitle` `<div>`,
            which would drop the subject out of the SR heading tree
            (`portal/account/page.tsx` HubCard, `portal/profile/page.tsx`
            SectionHeading — the same fix twice before this one). */}
        <CardHeader className="space-y-1">
          <p className="text-caption uppercase tracking-wide text-muted-foreground">
            {t('fields.subject')}
          </p>
          <h2
            id="broadcast-detail-fields-heading"
            className="font-heading text-base font-medium leading-snug"
          >
            {broadcast.subject}
          </h2>
        </CardHeader>
        <CardContent className="space-y-3">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">{t('fields.status')}</dt>
              <dd className="mt-1">
                {/* F1 UX hardening — use the shared `getBroadcastStatusBadgeProps`
                  (H4) so rejected broadcasts show as destructive (red), sending
                  pulses, etc. Previously every status rendered as a neutral
                  outline badge, losing the colour signal. */}
                {(() => {
                  const props = getBroadcastStatusBadgeProps(broadcast.status);
                  // Guard the i18n lookup; fall back to the raw status so a
                  // future enum value degrades gracefully. Cast hoisted once.
                  const statusKey = broadcast.status as Parameters<typeof tStatus>[0];
                  const statusLabel = tStatus.has(statusKey)
                    ? tStatus(statusKey)
                    : broadcast.status;
                  return (
                    <Badge variant={props.variant} className={cn(props.className)}>
                      {statusLabel}
                    </Badge>
                  );
                })()}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('fields.recipients')}</dt>
              <dd className="mt-1 tabular-nums">{broadcast.estimatedRecipientCount}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('fields.submittedAt')}</dt>
              <dd className="mt-1 text-muted-foreground">
                {broadcast.submittedAt !== null
                  ? dateFormatter.format(new Date(broadcast.submittedAt))
                  : '—'}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('fields.sentAt')}</dt>
              <dd className="mt-1 text-muted-foreground">
                {broadcast.sentAt !== null ? dateFormatter.format(new Date(broadcast.sentAt)) : '—'}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {/* F119 T141 (US6-AS2, FR-049) — the content itself, rendered as the
          recipient sees it. `PreviewSurface` owns the sandboxed frame and the
          translated empty / error states; this page only decides WHICH
          document goes in it. */}
      <Card role="region" aria-labelledby="broadcast-detail-body-heading">
        <CardHeader>
          <h2
            id="broadcast-detail-body-heading"
            className="font-heading text-base font-medium leading-snug"
          >
            {t('fields.content')}
          </h2>
        </CardHeader>
        <CardContent>
          <PreviewSurface
            state={previewState}
            height={DETAIL_PREVIEW_FRAME_HEIGHT}
          />
        </CardContent>
      </Card>

      {/* AS3 — Delivery breakdown (delivered / bounced / complained /
          soft-bounced / sent / total). Exposes testids for T129; uses
          aria-labelledby (not aria-label) so the visible h2 is the
          single accessible name (avoids SR double-announce — WCAG
          1.3.1 + 4.1.2). */}
      <Card
        role="region"
        data-testid="delivery-breakdown"
        aria-labelledby="delivery-breakdown-heading"
      >
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <h2 id="delivery-breakdown-heading" className="col-span-full text-h4">
            {t('delivery.title')}
          </h2>
          <DeliveryStat
            label={t('delivery.delivered')}
            value={delivery.delivered}
            testId="delivery-delivered-count"
          />
          <DeliveryStat
            label={t('delivery.bounced')}
            value={delivery.bounced}
            testId="delivery-bounced-count"
          />
          <DeliveryStat
            label={t('delivery.complained')}
            value={delivery.complained}
            testId="delivery-complained-count"
          />
          <DeliveryStat
            label={t('delivery.softBounced')}
            value={delivery.softBounced}
            testId="delivery-soft-bounced-count"
          />
          <DeliveryStat
            label={t('delivery.sent')}
            value={delivery.sent}
            testId="delivery-sent-count"
          />
          <DeliveryStat
            label={t('delivery.total')}
            value={delivery.total}
            testId="delivery-total-count"
          />
        </CardContent>
      </Card>

      {/* DV-12 — member Cancel action. Visible only when the broadcast is
          still cancellable (submitted or approved). getMemberBroadcast gates
          VISIBILITY (this page 404s a cross-member probe); the cancel POST is
          independently re-guarded at write time by the cancelBroadcast use-case
          (actor.kind==='member' + requestedByMemberId !== memberId → not_found).

          Scope note (review #4): the domain canCancel policy also permits
          cancelling a `sending` broadcast with pending split batch_manifests
          (F7.1a US1) — intentionally not surfaced here (dormant for <10k
          recipients; tracked as F7.1a follow-up). */}
      {(broadcast.status === 'submitted' || broadcast.status === 'approved') ? (
        <div className="flex justify-end">
          <CancelBroadcastAction
            broadcastId={broadcast.broadcastId as string}
            surface="member"
          />
        </div>
      ) : null}
    </DetailContainer>
  );
}

function DeliveryStat({
  label,
  value,
  testId,
}: {
  label: string;
  value: number;
  testId: string;
}): React.ReactElement {
  // `<dl>/<dt>/<dd>` carries the term/definition association at the
  // semantic level — screen readers announce "Delivered: 128" as a
  // unit (WCAG SC 1.3.2 meaningful sequence). Same pattern as the
  // sibling broadcast-detail-fields section above.
  return (
    <dl data-testid={testId} className="space-y-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-2xl font-semibold tabular-nums">{value}</dd>
    </dl>
  );
}
