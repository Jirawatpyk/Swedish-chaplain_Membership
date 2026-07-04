/**
 * T056 — /admin/invoices/new — create draft form (server-loaded dropdowns).
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { ArrowLeftIcon } from 'lucide-react';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.invoices.new');
  return { title: t('title') };
}
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromHeaders } from '@/lib/tenant-context';
import { env } from '@/lib/env';
import { bangkokLocalDate } from '@/lib/fiscal-year';
import { logger } from '@/lib/logger';
import { runListEvents, runResolveRegistrationEventId } from '@/lib/events-admin-deps';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { listPlans } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
import { directorySearch } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { type MemberOption, type PlanOption } from '../_components/invoice-form';
import { InvoiceCreateSwitcher } from './_components/invoice-create-switcher';
import type { EventOption } from './_components/event-fee-form';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function NewInvoiceDraftPage({
  searchParams,
}: {
  readonly searchParams: Promise<
    Record<string, string | string[] | undefined>
  >;
}) {
  const t = await getTranslations('admin.invoices.new');
  const { user } = await requireSession('staff');
  if (user.role !== 'admin') notFound();

  // Deep-link pre-fill from F3 member detail page CTA. UUID-validated
  // here so a malformed query string can't smuggle an attacker-chosen
  // string into the client form's initial state.
  const sp = await searchParams;
  const memberIdParam = typeof sp.memberId === 'string' ? sp.memberId : undefined;
  const initialMemberId =
    memberIdParam && UUID_RE.test(memberIdParam) ? memberIdParam : undefined;

  // Event-fee deep-link from the F6 attendee table ("Create invoice" CTA).
  // UUID-validated here (same defence as ?memberId) so a malformed query
  // string can't smuggle an attacker-chosen value into the client form.
  const eventRegParam =
    typeof sp.eventRegistrationId === 'string' ? sp.eventRegistrationId : undefined;
  const initialRegistrationId =
    eventRegParam && UUID_RE.test(eventRegParam) ? eventRegParam : undefined;

  const hdrs = await headers();
  const tenantCtx = resolveTenantFromHeaders(hdrs);

  const currentYear = new Date().getFullYear();

  // Plans — active only, current year.
  const plansDeps = buildPlansDeps(tenantCtx);
  const plansResult = await listPlans(
    { filter: { year: currentYear as never, activeOnly: true } },
    plansDeps,
  );
  function resolvePlanName(rawName: unknown, fallback: string): string {
    if (typeof rawName === 'object' && rawName !== null) {
      return (rawName as { en?: string }).en ?? fallback;
    }
    return String(rawName ?? fallback);
  }

  const plans: readonly PlanOption[] = plansResult.ok
    ? plansResult.value.data.map((p) => ({
        planId: p.plan_id,
        label: resolvePlanName(p.plan_name, p.plan_id),
        annualFeeMinorUnits: Number(p.annual_fee_minor_units),
      }))
    : [];

  // Build a fast lookup planId -> display name — used when composing
  // the member label so admins see "Fogmaker Thailand Demo (Regular
  // Corporate / 2026)" instead of the raw "regular" slug.
  const planNameById = new Map<string, string>(plans.map((p) => [p.planId, p.label]));

  // Active members — ceiling 500 covers SweCham 2026 count (~131)
  // with comfortable headroom for mid-year growth. Tenants larger
  // than this need server-paged search in a follow-up polish
  // (tracked as F4 Phase 10 smart-chamber feature #2).
  const membersDeps = buildMembersDeps(tenantCtx);
  const membersResult = await directorySearch(membersDeps, {
    limit: 500,
    // Inactive members are billable — create-invoice-draft only rejects
    // `archived` (member_archived), and the directory default itself is
    // ['active','inactive']. Active-only here silently blocked invoicing a
    // lapsed-but-not-archived member (incl. deep-links with their memberId).
    status: ['active', 'inactive'] as const,
  });
  const members: readonly MemberOption[] = membersResult.ok
    ? membersResult.value.items.map((r) => {
        const planLabel = planNameById.get(r.member.planId) ?? r.member.planId;
        return {
          memberId: r.member.memberId,
          label: `${r.member.companyName} (${planLabel} / ${r.member.planYear})`,
          currentPlanId: r.member.planId,
          currentPlanYear: r.member.planYear,
        };
      })
    : [];

  // Events — only when the F6 integration is live (the event-fee tab is
  // hidden behind real attendee data; with F6 off the selector still shows
  // but the Event tab renders the "no events" empty state). Loaded server-
  // side so the picker is a fast searchable combobox over the tenant's
  // events (ceiling 200 mirrors the F6 detail-endpoint pageSize cap).
  let events: readonly EventOption[] = [];
  let initialEventId: string | undefined;
  if (env.features.f6EventCreate) {
    const eventsResult = await runListEvents(tenantCtx.slug, {
      page: 1,
      pageSize: 200,
      includeArchived: false,
      partnerBenefitOnly: false,
      culturalEventOnly: false,
      categoryFilter: null,
    });
    if (eventsResult.ok) {
      events = eventsResult.value.items.map((e) => ({
        eventId: e.eventId,
        // CE start date (Asia/Bangkok) — BE is display-only, applied at the
        // user-facing renderer, not here. Matches the line-description date.
        label: `${e.name} (${bangkokLocalDate(e.startDate)})`,
      }));
    } else {
      logger.warn(
        { event: 'invoice_new_events_load_failed', tenantId: tenantCtx.slug },
        '[F4] /admin/invoices/new — listEvents failed; rendering empty Event tab',
      );
    }

    // Resolve the deep-link registration → its event id so the event picker
    // is pre-filled. A null (cross-tenant / missing) silently drops the
    // pre-fill; the client still preselects the Event tab via the regId.
    if (initialRegistrationId) {
      initialEventId =
        (await runResolveRegistrationEventId(
          tenantCtx.slug,
          initialRegistrationId,
        )) ?? undefined;
    }
  }

  return (
    <FormContainer>
      <PageHeader
        title={t('title')}
        subtitle={t('description')}
        actions={
          <Link
            href="/admin/invoices"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"
          >
            <ArrowLeftIcon className="size-4" aria-hidden="true" />
            {t('cancel')}
          </Link>
        }
      />
      <Card>
        <CardContent>
          <InvoiceCreateSwitcher
            members={members}
            plans={plans}
            events={events}
            taxAtPayment={env.features.f088TaxAtPayment}
            {...(initialMemberId ? { initialMemberId } : {})}
            {...(initialEventId ? { initialEventId } : {})}
            {...(initialRegistrationId ? { initialRegistrationId } : {})}
          />
        </CardContent>
      </Card>
    </FormContainer>
  );
}
