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
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { getBroadcastStatusBadgeProps } from '@/components/broadcast/status-badge-mapping';
import { cn } from '@/lib/utils';
import { logger } from '@/lib/logger';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  getMemberBroadcast,
  makeGetMemberBroadcastDeps,
  parseBroadcastId,
} from '@/modules/broadcasts';
import { intlLocale } from '@/components/broadcast/quota-banner';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { randomUUID } from 'node:crypto';

/* The detail page is per-(tenant, member, broadcastId) — caching across
 * users doesn't apply, and the route depends on the member-scoped
 * `runInTenant` lookup. Force dynamic rendering so `notFound()` returns
 * a true HTTP 404 (Next.js 16 sets static-cache responses to 200 even
 * when the rendered body is the not-found UI; AS5 spec mandates 404). */
export const dynamic = 'force-dynamic';

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
  const dateFormatter = new Intl.DateTimeFormat(intlLocale(locale), {
    dateStyle: 'medium',
    timeStyle: 'short',
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
        <CardContent className="space-y-3">
          {/* The subject value is the card's title (and its accessible
              region name); "Subject" is a small overline label so the value
              reads as the dominant element rather than being subordinate to
              its own label (UX R2-I3 — the text-h4 label outweighed the 16px
              value). */}
          <div className="space-y-1">
            <p className="text-caption uppercase tracking-wide text-muted-foreground">
              {t('fields.subject')}
            </p>
            <h2 id="broadcast-detail-fields-heading" className="text-h4">
              {broadcast.subject}
            </h2>
          </div>
          <dl className="grid grid-cols-2 gap-3 pt-2 text-sm">
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
