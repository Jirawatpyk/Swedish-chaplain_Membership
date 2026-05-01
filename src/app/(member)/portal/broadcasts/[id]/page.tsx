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
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  asBroadcastId,
  getMemberBroadcast,
  makeGetMemberBroadcastDeps,
} from '@/modules/broadcasts';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { randomUUID } from 'node:crypto';

export const revalidate = 60;

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
  const memberLookup = await membersDeps.memberRepo.findByLinkedUserId(
    tenant,
    session.user.id,
  );
  if (!memberLookup.ok) notFound();
  const memberId = memberLookup.value.memberId;

  // Validate ID shape early — invalid UUID = not found (no audit).
  let broadcastId: ReturnType<typeof asBroadcastId>;
  try {
    broadcastId = asBroadcastId(id);
  } catch {
    notFound();
  }

  const result = await getMemberBroadcast(
    makeGetMemberBroadcastDeps(tenant.slug),
    {
      memberId,
      broadcastId,
      actorUserId: session.user.id,
      requestId: randomUUID(),
    },
  );
  if (!result.ok) notFound();

  const { broadcast, delivery } = result.value;

  const t = await getTranslations('portal.broadcasts.detail');
  const tStatus = await getTranslations('portal.broadcasts.list.status');
  const locale = await getLocale();
  const dateFormatter = new Intl.DateTimeFormat(
    locale === 'th' ? 'th-TH-u-ca-buddhist' : locale,
    { dateStyle: 'medium', timeStyle: 'short' },
  );

  return (
    <DetailContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />

      <Link
        href="/portal/benefits/e-blasts"
        className={buttonVariants({ variant: 'ghost', size: 'sm' })}
      >
        ← {t('back')}
      </Link>

      <section className="mt-6 space-y-3 rounded-md border p-4">
        <h2 className="text-sm font-semibold">{t('fields.subject')}</h2>
        <p className="text-base">{broadcast.subject}</p>
        <dl className="grid grid-cols-2 gap-3 pt-2 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">{t('fields.status')}</dt>
            <dd className="mt-1">
              <Badge variant="outline">
                {tStatus(broadcast.status as Parameters<typeof tStatus>[0])}
              </Badge>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">
              {t('fields.recipients')}
            </dt>
            <dd className="mt-1 tabular-nums">
              {broadcast.estimatedRecipientCount}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">
              {t('fields.submittedAt')}
            </dt>
            <dd className="mt-1 text-muted-foreground">
              {broadcast.submittedAt !== null
                ? dateFormatter.format(new Date(broadcast.submittedAt))
                : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('fields.sentAt')}</dt>
            <dd className="mt-1 text-muted-foreground">
              {broadcast.sentAt !== null
                ? dateFormatter.format(new Date(broadcast.sentAt))
                : '—'}
            </dd>
          </div>
        </dl>
      </section>

      {/* AS3 — Delivery breakdown (delivered / bounced / complained /
          soft-bounced / pending / total). All testids present so T129
          can assert independently of seed data. */}
      <section
        data-testid="delivery-breakdown"
        aria-label={t('delivery.title')}
        className="mt-6 grid grid-cols-2 gap-3 rounded-md border p-4 sm:grid-cols-3"
      >
        <h2 className="col-span-full text-sm font-semibold">
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
          value={delivery.soft_bounced}
          testId="delivery-soft-bounced-count"
        />
        <DeliveryStat
          label={t('delivery.sent')}
          value={delivery.sent}
          testId="delivery-pending-count"
        />
        <DeliveryStat
          label={t('delivery.total')}
          value={delivery.total}
          testId="delivery-total-count"
        />
      </section>
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
  return (
    <div data-testid={testId} className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}
