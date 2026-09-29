/**
 * 122 US5b-1 (T552) — loads the figures strip. Its own Suspense boundary at
 * the call site, so the invoice and renewal reads never hold up the header or
 * the company card. The renewal/engagement read is the same `cache()`d call
 * the Renewal & Health card makes, so the strip adds one query (Outstanding),
 * and only for a role that may read invoices.
 */
import { env } from '@/lib/env';
import { SkeletonBlock } from '@/components/shell/page-skeletons';
import type { TenantContext } from '@/modules/tenants';
import { loadMemberOutstanding } from '../_lib/member-outstanding';
import { loadMemberRenewalHealth } from '../_lib/member-renewal-health';
import { MemberSummaryStrip, type MemberSummaryStripProps } from './member-summary-strip';

export async function MemberSummaryStripSection({
  tenant,
  memberId,
  canReadInvoices,
  primaryContact,
  lastActivityIso,
}: {
  readonly tenant: TenantContext;
  readonly memberId: string;
  readonly canReadInvoices: boolean;
  readonly primaryContact: MemberSummaryStripProps['primaryContact'];
  readonly lastActivityIso: string | null;
}) {
  const [outstanding, health] = await Promise.all([
    canReadInvoices ? loadMemberOutstanding(tenant.slug, memberId) : Promise.resolve(null),
    loadMemberRenewalHealth(tenant, memberId),
  ]);
  return (
    <MemberSummaryStrip
      outstanding={outstanding}
      expiry={
        health.readFailed
          ? { state: 'unavailable' }
          : { state: 'ok', expiryIso: health.expiryIso, daysRemaining: health.daysRemaining }
      }
      primaryContact={primaryContact}
      engagement={env.features.f9Dashboard ? { band: health.engagementBand, lastActivityIso } : null}
      now={new Date()}
    />
  );
}

/** Same frame and height as the strip, so nothing moves when it lands. */
export function MemberSummaryStripSkeleton({ cells }: { readonly cells: number }) {
  return (
    <div
      aria-hidden="true"
      className="grid grid-cols-2 rounded-[var(--aura-radius-lg)] border border-[var(--aura-border-default)] bg-[var(--aura-bg-surface)] sm:grid-cols-4"
    >
      {Array.from({ length: cells }).map((_, i) => (
        <div key={i} className="flex flex-col gap-1.5 px-5 py-3.5">
          <SkeletonBlock className="h-3 w-20" />
          <SkeletonBlock className="h-4 w-28" />
          <SkeletonBlock className="h-3 w-24" />
        </div>
      ))}
    </div>
  );
}
