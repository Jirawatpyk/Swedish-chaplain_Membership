/**
 * T056 — /admin/invoices/new — create draft form (server-loaded dropdowns).
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { getTranslations, getLocale } from 'next-intl/server';
import { ArrowLeftIcon } from 'lucide-react';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.invoices.new');
  return { title: t('title') };
}
import { requirePagePermission } from '@/lib/rbac';
import { resolveTenantFromHeaders } from '@/lib/tenant-context';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import {
  runListEventNamesByIds,
  runListEvents,
  runResolveRegistrationEventId,
} from '@/lib/events-admin-deps';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Alert, buttonClass } from '@jirawatpyk/aura-react/server';
import { listPlans } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
import { asMemberId, getMember } from '@/modules/members';
import { runListMemberPickerOptions } from '@/lib/members-picker-deps';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { resolvePlanName } from '@/lib/resolve-plan-name';
import { type MemberOption, type PlanOption } from '../_components/invoice-form';
import { InvoiceCreateSwitcher } from './_components/invoice-create-switcher';
import { drizzleTenantSettingsRepo } from '@/modules/invoicing';
import type { EventOption } from './_components/event-fee-form';
import { toEventOption, withDeepLinkedEvent } from './_lib/event-options';
import { MEMBER_PRELOAD_LIMIT, toMemberOption, withDeepLinkedMember } from './_lib/member-options';
import { deepLinkNotices } from './_lib/deep-link-notices';
import { requestIdFromHeaders } from '@/lib/request-id';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Events the page preloads for the picker (newest first). */
const EVENT_PRELOAD = 200;

export default async function NewInvoiceDraftPage({
  searchParams,
}: {
  readonly searchParams: Promise<
    Record<string, string | string[] | undefined>
  >;
}) {
  const t = await getTranslations('admin.invoices.new');
  const locale = await getLocale();
  const { user } = await requirePagePermission('invoicing.write');

  // Deep-link pre-fill from F3 member detail page CTA. UUID-validated
  // here so a malformed query string can't smuggle an attacker-chosen
  // string into the client form's initial state.
  const sp = await searchParams;
  const memberIdParam = typeof sp.memberId === 'string' ? sp.memberId : undefined;
  const initialMemberId =
    memberIdParam && UUID_RE.test(memberIdParam) ? memberIdParam.toLowerCase() : undefined;

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

  const plans: readonly PlanOption[] = plansResult.ok
    ? plansResult.value.data.map((p) => ({
        planId: p.plan_id,
        // P1-8 — locale-aware (was hardcoded `.en`, silently dropping TH/SV
        // on the tax-document plan label for a Thai/Swedish admin session).
        label: resolvePlanName(p.plan_name, p.plan_id, locale),
        annualFeeMinorUnits: Number(p.annual_fee_minor_units),
      }))
    : [];

  // Build a fast lookup planId -> display name — used when composing
  // the member label so admins see "Fogmaker Thailand Demo (Regular
  // Corporate / 2026)" instead of the raw "regular" slug.
  const planNameById = new Map<string, string>(plans.map((p) => [p.planId, p.label]));

  // #82 / #89 — the preload is a slim read (the four fields an option shows,
  // no contact rows) of at most MEMBER_PRELOAD_LIMIT members, in the
  // directory's default order. A full preload turns the picker's server
  // search on, so any member can be found.
  const membersDeps = buildMembersDeps(tenantCtx);
  const preloadedMembers: readonly MemberOption[] = (
    await runListMemberPickerOptions(tenantCtx.slug, {
      limit: MEMBER_PRELOAD_LIMIT,
      // Inactive members are billable — create-invoice-draft only rejects
      // `archived` (member_archived). Active-only here silently blocked
      // invoicing a lapsed-but-not-archived member (incl. deep-links with
      // their memberId).
      statuses: ['active', 'inactive'],
    })
  ).map((m) => toMemberOption(m, planNameById, locale));
  const memberSearchEnabled = preloadedMembers.length >= MEMBER_PRELOAD_LIMIT;
  // A `?memberId=` past the preload is read by id and added, so the "New
  // invoice" link on a member page always lands on that member. An archived
  // member stays out (FR-037 refuses to bill one).
  let deepLinkedMember: MemberOption | null = null;
  if (initialMemberId && !preloadedMembers.some((m) => m.memberId === initialMemberId)) {
    const found = await getMember(
      asMemberId(initialMemberId),
      { actorUserId: user.id, requestId: requestIdFromHeaders(hdrs) },
      membersDeps,
    );
    if (found.ok && found.value.member.status !== 'archived') {
      deepLinkedMember = toMemberOption(found.value.member, planNameById, locale);
    }
  }
  const members = withDeepLinkedMember(preloadedMembers, deepLinkedMember);

  // Events — only when the F6 integration is live (the event-fee tab is
  // hidden behind real attendee data; with F6 off the selector still shows
  // but the Event tab renders the "no events" empty state). Loaded server-
  // side so the picker is a fast searchable combobox over the tenant's
  // events (ceiling 200 mirrors the F6 detail-endpoint pageSize cap).
  let events: readonly EventOption[] = [];
  // #732 — set when the preload is a full page, so the picker's search asks
  // the server for events that started at or before the oldest one shown.
  let eventSearchBefore: string | null = null;
  let initialEventId: string | undefined;
  // The event-fee VAT preview splits at the rate issuance pins
  // (`tenant_invoice_settings.vat_rate`), never a hardcoded 7%. `null` (no
  // settings) → the preview shows the total only.
  let vatRateBps: number | null = null;
  if (env.features.f6EventCreate) {
    const eventsResult = await runListEvents(tenantCtx.slug, {
      page: 1,
      pageSize: EVENT_PRELOAD,
      includeArchived: false,
      partnerBenefitOnly: false,
      culturalEventOnly: false,
      categoryFilter: null,
    });
    // A failed read must not take the whole page (membership tab included)
    // down with it: the preview degrades to total-only, like no settings.
    try {
      const invoiceSettings = await drizzleTenantSettingsRepo.getForIssue(tenantCtx.slug);
      vatRateBps = invoiceSettings ? Number(invoiceSettings.vatRate.numerator) : null;
    } catch (err) {
      logger.warn(
        { event: 'invoice_new_settings_load_failed', tenantId: tenantCtx.slug, err },
        '[F4] /admin/invoices/new — invoice settings read failed; event-fee VAT preview shows the total only',
      );
    }
    if (eventsResult.ok) {
      // CE start date (Asia/Bangkok) — BE is display-only, applied at the
      // user-facing renderer, not here. Matches the line-description date.
      const loaded = eventsResult.value.items;
      if (loaded.length >= EVENT_PRELOAD) eventSearchBefore = loaded[loaded.length - 1]?.startDate ?? null;
      events = loaded.map((e) =>
        toEventOption({ eventId: e.eventId, name: e.name, startDateIso: e.startDate }),
      );
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

    // #54 — the form preselects the deep-linked event only when it is among
    // the options, and the list holds only the newest 200. Add an older one
    // (one tenant-scoped read; a miss or a failed read leaves the list as is).
    // Marked with a second line saying why it is there (and archived, when it
    // is). A throw degrades like the list read above: never the whole page.
    if (initialEventId && !events.some((e) => e.eventId === initialEventId)) {
      try {
        const found = (await runListEventNamesByIds(tenantCtx.slug, [initialEventId])).get(
          initialEventId,
        );
        if (found) {
          const tPicker = await getTranslations('admin.invoices.eventFeeForm.eventPicker');
          events = withDeepLinkedEvent(
            events,
            toEventOption(
              { eventId: initialEventId, name: found.name, startDateIso: found.startDateIso },
              tPicker(found.archived ? 'fromLinkArchived' : 'fromLink'),
            ),
          );
        }
      } catch (err) {
        logger.warn(
          { event: 'invoice_new_deep_link_event_load_failed', tenantId: tenantCtx.slug, err },
          '[F4] /admin/invoices/new — deep-linked event read failed; Event tab opens without it',
        );
      }
    }
  }

  const notices = deepLinkNotices({
    initialMemberId,
    members,
    // With F6 off there is no Event tab to say it on.
    initialRegistrationId: env.features.f6EventCreate ? initialRegistrationId : undefined,
    initialEventId,
    events,
  });

  return (
    <FormContainer align="start">
      <PageHeader
        title={t('title')}
        subtitle={t('description')}
        actions={
          // Below 1024px the shell's "← Invoices" back link takes its place.
          <Link href="/admin/invoices" className={buttonClass({ variant: 'secondary', className: 'max-lg:hidden' })}>
            <ArrowLeftIcon className="size-4" aria-hidden="true" />
            {t('cancel')}
          </Link>
        }
      />
      {/* #89 (UX L6) — a deep link that cannot be used says so. */}
      {notices.map((n) => (
        // A standing notice rendered with the page, not a live update (AURA: role="note").
        <Alert key={n} tone="info" role="note" data-testid={`invoice-new-${n}`}>
          {t(n)}
        </Alert>
      ))}
      {/* Spec 122 US8 (T807, `Admin-invoice-new`) — the switcher draws the
          board's cards: "What is this invoice for?", then the chosen form. */}
      <InvoiceCreateSwitcher
        members={members}
        memberSearchEnabled={memberSearchEnabled}
        plans={plans}
        events={events}
        eventSearchBefore={eventSearchBefore}
        taxAtPayment={env.features.f088TaxAtPayment}
        vatRateBps={vatRateBps}
        {...(initialMemberId ? { initialMemberId } : {})}
        {...(initialEventId ? { initialEventId } : {})}
        {...(initialRegistrationId ? { initialRegistrationId } : {})}
      />
    </FormContainer>
  );
}
