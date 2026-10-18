/**
 * /admin/marketing/audience — 108 PR-D (US4 — FR-027a, FR-034, FR-035,
 * FR-035a, FR-035b, FR-035c).
 *
 * The permanent Marketing audience page: every non-removed contact of the
 * tenant with its marketing state, who switched it and when, filterable by
 * member / role / state / eligibility, 50 rows per page. It is also the
 * FR-027a pre-flight surface — the header offers the "secondary, on,
 * eligible" preset that lists exactly the people who will NEWLY receive a
 * broadcast under the 1:N audience rule.
 *
 * Gate: `contacts.read` (admin, super_admin, marketing, and manager
 * read-only). The inline switch renders only for `contacts.marketing`
 * holders — a read-only viewer gets a badge and a note, never a disabled
 * control (FR-035). Columns are the FR-035 allow-list and nothing more
 * (FR-035a): no `pii_sensitive` field, no download.
 *
 * Review cycle 11: the preset action wraps (SV is +28 % longer than EN and
 * overflowed a 320-px page — H6) and shows when it is active (L5); the count
 * line distinguishes "no contacts yet" from "none match" (M4) and is the
 * focus fallback when a row leaves a state-filtered view (H4); the degraded
 * panel uses the semantic warning tokens (M6); the read-only note is the
 * shared banner (M8); only ONE live region announces the count (L2).
 */
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { SearchXIcon } from 'lucide-react';
import { canPerform, requirePagePermission } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { buildMarketingAudienceDeps } from '@/lib/contact-marketing-deps';
import { env } from '@/lib/env';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import {
  parseMarketingAudienceParams,
  type MarketingAudienceSearchParams,
} from '@/lib/marketing-audience-filter';
import { listMarketingAudience } from '@/modules/members';
import { resolveActorIdentities } from '@/modules/auth';
import { TableContainer } from '@/components/layout';
import { EmptyState } from '@/components/shell/empty-state';
import { type AudienceTableRow } from './_components/audience-table';
import { AudienceTableSkeleton } from './_components/audience-table-skeleton';
import { AudienceFrame, AudienceResults } from './_components/audience-view';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.marketing.audience');
  return { title: t('title') };
}

export default async function MarketingAudiencePage({
  searchParams,
}: {
  searchParams: Promise<MarketingAudienceSearchParams>;
}) {
  const { user } = await requirePagePermission('contacts.read');
  // The nav item and the ⌘K entry hide this page when F7 is off (the page is
  // about E-Blast recipients); a hidden page must not serve on its URL either
  // — same convention as /admin/events (review M-11).
  if (!env.features.f7Broadcasts) notFound();
  const query = await searchParams;
  const canMarketing = canPerform(user.role, 'contacts.marketing');
  const { filter } = parseMarketingAudienceParams(query);
  const presetActive =
    filter.kind === 'secondary' && filter.state === 'on' && filter.eligible;

  return (
    <TableContainer>
      <AudienceFrame canMarketing={canMarketing} presetActive={presetActive}>
        <Suspense fallback={<AudienceTableSkeleton withSwitch={canMarketing} />}>
          <AudienceBody query={query} canMarketing={canMarketing} />
        </Suspense>
      </AudienceFrame>
    </TableContainer>
  );
}

async function AudienceBody({
  query,
  canMarketing,
}: {
  query: MarketingAudienceSearchParams;
  canMarketing: boolean;
}) {
  const tenant = resolveTenantFromRequest();
  const locale = await getLocale();
  const t = await getTranslations('admin.marketing.audience');
  const { filter, page, narrowed } = parseMarketingAudienceParams(query);

  const result = await listMarketingAudience({ filter, page }, buildMarketingAudienceDeps(tenant));
  if (!result.ok) {
    return (
      <EmptyState
        icon={SearchXIcon}
        title={t('error.title')}
        description={t('error.description')}
        bordered={false}
        data-testid="audience-error"
      />
    );
  }
  const { rows, total, pageSize, degraded } = result.value;

  // "Changed by": a staff user id → display name (data minimisation: name
  // only, never email — same rule as the audit viewer); the contact's own
  // change → "the contact". Erased staff users simply fall back to "Staff".
  const staffIds = [
    ...new Set(
      rows
        .filter((r) => r.changedSource === 'staff' && r.changedByUserId !== null)
        .map((r) => r.changedByUserId as string),
    ),
  ];
  const identities = staffIds.length > 0 ? await resolveActorIdentities(staffIds) : new Map();

  const tableRows: AudienceTableRow[] = rows.map((r) => ({
    contactId: r.contactId,
    memberId: r.memberId,
    companyName: r.companyName,
    contactName: `${r.firstName} ${r.lastName}`.trim(),
    email: r.email,
    isPrimary: r.isPrimary,
    memberStatus: r.memberStatus,
    memberHalted: r.memberHalted,
    memberErased: r.memberErased,
    state: r.state,
    reasons: r.reasons,
    changedBy:
      r.changedSource === null
        ? null
        : r.changedSource === 'self'
          ? t('changedBy.contact')
          : (identities.get(r.changedByUserId ?? '')?.displayName ?? t('changedBy.staff')),
    changedAt:
      r.changedAt === null
        ? null
        : formatLocalisedDate(r.changedAt.toISOString(), locale, {
            dateStyle: 'medium',
            timeStyle: 'short',
          }),
  }));

  return (
    <AudienceResults
      rows={tableRows}
      total={total}
      page={page}
      pageSize={pageSize}
      narrowed={narrowed}
      degraded={degraded}
      canMarketing={canMarketing}
      // A state-filtered view drops a row the moment its state changes (H4).
      leavesView={filter.state !== undefined}
    />
  );
}
