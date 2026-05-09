/**
 * T067 — /admin/members/[memberId] detail page (US2 deep-link).
 *
 * Server component — runs the `getMember` use case which emits
 * `member_cross_tenant_probe` on 404 per FR-022. Renders member metadata
 * + contacts grouped primary/secondary + FR-030 copy-to-clipboard
 * affordances on member_id / email / tax_id.
 *
 * Audit timeline lands in US6 (B.4+).
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import {
  ArrowLeftIcon,
  HelpCircleIcon,
  PencilIcon,
  ClockIcon,
} from 'lucide-react';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { logger } from '@/lib/logger';
import { headers } from 'next/headers';
import { getMember, archiveWindowStatus } from '@/modules/members';
import type { MemberId, Contact } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { CopyButton } from '@/components/members/copy-button';
import { InvitePortalButton } from '@/components/members/invite-portal-button';
import { ArchivedBanner } from '@/components/members/archived-banner';
import { ArchiveMemberButton } from '@/components/members/archive-member-button';
import { Suspense } from 'react';
import { MemberInvoicesSection } from './_components/member-invoices-section';
import { MemberInvoicesSkeleton } from './_components/member-invoices-skeleton';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PageProps {
  readonly params: Promise<{ memberId: string }>;
  readonly searchParams: Promise<
    Record<string, string | string[] | undefined>
  >;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { memberId } = await params;
  // Layout template appends "· SweCham Membership"; bare title here
  // avoids the "Member · SweCham · SweCham Membership" redundancy.
  if (!UUID_RE.test(memberId)) return { title: 'Members' };
  return { title: 'Member' };
}

function Field({
  label,
  value,
  fallback = '—',
  mono = false,
  extra,
}: {
  label: string;
  value: string | number | null | undefined;
  fallback?: string;
  mono?: boolean;
  extra?: React.ReactNode;
}) {
  const v = value === null || value === undefined || value === '' ? null : String(value);
  return (
    <div className="flex flex-col gap-1 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="flex items-center gap-2 text-sm">
        {v !== null && (
          <span className={mono ? 'font-mono text-xs' : ''}>{v}</span>
        )}
        {v === null && extra === undefined && (
          <span className="text-muted-foreground">{fallback}</span>
        )}
        {/* `extra` always renders — it may be the sole content (e.g. a
            StatusBadge passed without a value). Previously gated on `v`
            which hid the badge when the value was null. */}
        {extra}
      </dd>
    </div>
  );
}

function StatusBadge({ status }: { status: 'active' | 'inactive' | 'archived' }) {
  return (
    <Badge
      variant={
        status === 'active'
          ? 'default'
          : status === 'inactive'
            ? 'secondary'
            : 'outline'
      }
    >
      {status}
    </Badge>
  );
}

function ContactBlock({
  contact,
  memberId,
  t,
}: {
  contact: Contact;
  memberId: string;
  t: Awaited<ReturnType<typeof getTranslations<'admin.members.detail'>>>;
}) {
  // "Invite to portal" is only shown when the contact has an email and
  // is not already linked to an F1 portal account (FR-012 / T056).
  const canInvite = Boolean(contact.email) && !contact.linkedUserId;
  // Rendered as a plain flat row (no border, no bg) inside the outer
  // Contacts Card. Multiple contacts are separated by <Separator />
  // elements in the parent CardContent — no nested cards, no visual
  // card-in-card anti-pattern.
  return (
    <div>
      <div className="mb-3 flex flex-row items-start justify-between gap-4">
        <h3 className="text-base font-semibold">
          {`${contact.firstName} ${contact.lastName}`.trim()}
          {contact.isPrimary && (
            <Badge className="ml-2" variant="default">
              {t('sections.primary')}
            </Badge>
          )}
          {contact.linkedUserId && (
            <Badge className="ml-2" variant="secondary">
              {t('portal.linked')}
            </Badge>
          )}
        </h3>
        {canInvite && (
          <InvitePortalButton memberId={memberId} contactId={contact.contactId} />
        )}
      </div>
      <dl className="grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2">
        <Field
          label={t('fields.email')}
          value={contact.email}
          extra={
            <CopyButton value={contact.email} label={t('copy.copyEmail')} />
          }
        />
        <Field label={t('fields.phone')} value={contact.phone} />
        <Field label={t('fields.roleTitle')} value={contact.roleTitle} />
        <Field
          label={t('fields.preferredLanguage')}
          value={contact.preferredLanguage.toUpperCase()}
        />
      </dl>
    </div>
  );
}

export default async function MemberDetailPage({
  params,
  searchParams,
}: PageProps) {
  const sp = await searchParams;
  const invStatusRaw = typeof sp.invStatus === 'string' ? sp.invStatus : undefined;
  const invYearRaw = typeof sp.invYear === 'string' ? sp.invYear : undefined;
  const invQRaw = typeof sp.invQ === 'string' ? sp.invQ : undefined;
  const invStatus = invStatusRaw && invStatusRaw !== 'all' ? invStatusRaw : undefined;
  const invYear = (() => {
    if (!invYearRaw || invYearRaw === 'all') return undefined;
    const n = Number.parseInt(invYearRaw, 10);
    return Number.isFinite(n) && n >= 2020 && n <= 2100 ? n : undefined;
  })();
  const invQ = (() => {
    if (!invQRaw) return undefined;
    const trimmed = invQRaw.trim().slice(0, 64);
    return trimmed.length > 0 ? trimmed : undefined;
  })();
  const { memberId } = await params;
  if (!UUID_RE.test(memberId)) notFound();

  const session = await requireSession('staff');
  const h = await headers();
  // Pass a pseudo-Request so resolveTenantFromRequest can honour the
  // T115t `x-tenant` header override used by throwaway-tenant E2E.
  // Without this the fn falls back to env.tenant.slug, silently
  // breaking test harnesses that target the member detail page.
  const pseudoReq = new Request('http://localhost:3100', { headers: h });
  const tenant = resolveTenantFromRequest(pseudoReq as never);
  const requestId = requestIdFromHeaders(h);

  const deps = buildMembersDeps(tenant);
  const result = await getMember(
    memberId as MemberId,
    { actorUserId: 'server-component', requestId },
    deps,
  );

  const t = await getTranslations('admin.members.detail');
  const tRoot = await getTranslations('admin.members');

  if (!result.ok) {
    if (result.error.type === 'not_found') {
      return (
        <DetailContainer>
          <Card>
            <CardContent className="flex flex-col items-center gap-4 p-10 text-center">
              <h2 className="text-h2 text-xl font-semibold">
                {t('notFound.title')}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t('notFound.description')}
              </p>
              <Link
                href="/admin/members"
                className={buttonVariants({ variant: 'outline' })}
              >
                <ArrowLeftIcon className="size-4" />
                {t('notFound.cta')}
              </Link>
            </CardContent>
          </Card>
        </DetailContainer>
      );
    }
    // Generic server error — log with full context for ops, throw a
    // sanitised message so the route-level error.tsx boundary and any
    // leaked stack trace don't expose internal detail to the client.
    logger.error(
      { requestId, err: result.error, memberId },
      'admin.members.detail.getMember_failed',
    );
    throw new Error('admin.members.detail: getMember failed');
  }

  const { member, contacts } = result.value;
  const primary = contacts.find((c) => c.isPrimary && c.removedAt === null);
  const secondary = contacts.filter(
    (c) => !c.isPrimary && c.removedAt === null,
  );

  // Resolve plan display name via PlanLookupPort (single-plan fetch,
  // no listPlans). Falls back to the slug if the plan row is missing
  // (defensive — shouldn't happen for an active member, but keeps the
  // page resilient to data drift).
  const planLookup = await deps.plans.getPlan(
    tenant,
    member.planId,
    member.planYear,
  );
  const planDisplayName = planLookup.ok
    ? planLookup.value.planNameEn
    : member.planId;

  const windowStatus =
    member.status === 'archived' && member.archivedAt
      ? archiveWindowStatus(member.archivedAt, new Date())
      : null;

  return (
    <DetailContainer>
      <PageHeader
        title={member.companyName}
        subtitle={tRoot('subtitle')}
        actions={
          <>
            {/* "Back to members" button removed per ux-standards.md § 11/19
              * — the global BreadcrumbNav (admin/layout.tsx) already exposes
              * back navigation at "Admin > Members > [Company]". Duplicating
              * it as an action-row button competed with Edit/Archive for
              * visual attention and diluted the primary-action hierarchy. */}
            <Link
              href={`/admin/members/${member.memberId}/timeline`}
              className={buttonVariants({ variant: 'outline' })}
            >
              <ClockIcon className="size-4" />
              {t('sections.audit')}
            </Link>
            {member.status !== 'archived' && (
              <>
                {/* Destructive action sits LEFT of the primary — Fitts's
                    Law: rightmost button is easiest to click, so Edit
                    (primary + frequent) stays rightmost and Archive
                    (destructive) is one step further from the natural
                    click target. Matches GitHub/Stripe admin convention. */}
                <ArchiveMemberButton
                  memberId={member.memberId}
                  companyName={member.companyName}
                />
                <Link
                  href={`/admin/members/${member.memberId}/edit`}
                  className={buttonVariants()}
                >
                  <PencilIcon className="size-4" />
                  {t('editCta')}
                </Link>
              </>
            )}
          </>
        }
      />

      {member.status === 'archived' &&
          member.archivedAt &&
          windowStatus &&
          (windowStatus.state === 'within_window' ||
            windowStatus.state === 'window_expired') && (
            <ArchivedBanner
              memberId={member.memberId}
              archivedAtIso={member.archivedAt.toISOString()}
              windowStatus={windowStatus}
            />
          )}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('sections.company')}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2 lg:grid-cols-3">
              <Field
                label={t('fields.memberId')}
                value={member.memberId}
                mono
                extra={
                  <CopyButton
                    value={member.memberId}
                    label={t('copy.copyMemberId')}
                  />
                }
              />
              <Field
                label={t('fields.status')}
                value={null}
                extra={<StatusBadge status={member.status} />}
              />
              <Field
                label={t('fields.country')}
                value={member.country}
              />
              <Field
                label={t('fields.legalEntityType')}
                value={member.legalEntityType}
              />
              <Field
                label={t('fields.taxId')}
                value={member.taxId}
                mono
                {...(member.taxId
                  ? {
                      extra: (
                        <CopyButton
                          value={member.taxId}
                          label={t('copy.copyTaxId')}
                        />
                      ),
                    }
                  : {})}
              />
              <Field label={t('fields.website')} value={member.website} />
              <Field
                label={t('fields.foundedYear')}
                value={member.foundedYear}
              />
              <Field
                label={t('fields.turnoverThb')}
                value={
                  member.turnoverThb !== null
                    ? member.turnoverThb.toLocaleString()
                    : null
                }
              />
              <Field
                label={t('fields.registrationDate')}
                value={member.registrationDate.toISOString().slice(0, 10)}
              />
              <Field
                label={t('fields.registrationFeePaid')}
                value={
                  member.registrationFeePaid
                    ? t('fields.registrationFeePaidYes')
                    : t('fields.registrationFeePaidNo')
                }
              />
              <Field
                label={t('fields.plan')}
                value={planDisplayName}
              />
              <Field label={t('fields.planYear')} value={member.planYear} />
              <Field
                label={t('fields.planId')}
                value={member.planId}
                mono
              />
              <Field
                label={t('fields.lastActivityAt')}
                // ISO string ensures server + client render the same text;
                // localised display belongs in a Client Component hydrated
                // after mount (deferred to US6 Timeline).
                value={
                  member.lastActivityAt
                    ? member.lastActivityAt.toISOString().replace('T', ' ').slice(0, 16)
                    : null
                }
              />
              {member.status === 'archived' && (
                <Field
                  label={t('fields.archivedAt')}
                  value={
                    member.archivedAt
                      ? member.archivedAt.toISOString().replace('T', ' ').slice(0, 16)
                      : null
                  }
                />
              )}
            </dl>
            {member.description && (
              <div className="mt-4 border-t pt-4">
                <dt className="text-xs text-muted-foreground mb-1">
                  {t('fields.description')}
                </dt>
                <dd className="text-sm whitespace-pre-wrap">
                  {member.description}
                </dd>
              </div>
            )}
            {member.notes && (
              <div className="mt-4 border-t pt-4">
                <dt className="text-xs text-muted-foreground mb-1">
                  {t('fields.notes')}
                </dt>
                <dd className="text-sm whitespace-pre-wrap">{member.notes}</dd>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Single Contacts Card groups primary + secondary contacts
            under one CardTitle — matches the Company section pattern
            so every content group on the page has consistent card
            framing. Individual contacts render as bordered rows inside
            CardContent (ContactBlock), not as nested cards. */}
        <Card>
          <CardHeader className="flex flex-row items-center gap-2">
            <CardTitle className="text-base">{t('sections.contacts')}</CardTitle>
            {/* T097 — Emergency primary contact transfer helper. Clicking
                the icon opens a Popover (not a hover Tooltip — we need
                tap-discoverable on mobile) that explains the two-step
                procedure per spec Edge Cases: add the new person as a
                secondary contact, then promote them. */}
            <Popover>
              <PopoverTrigger
                aria-label={t('emergencyPrimary.ariaLabel')}
                className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <HelpCircleIcon className="size-4" aria-hidden="true" />
              </PopoverTrigger>
              <PopoverContent className="max-w-sm text-sm" sideOffset={4}>
                <p className="font-medium">{t('emergencyPrimary.title')}</p>
                <p className="mt-2 text-muted-foreground">
                  {t('emergencyPrimary.body')}
                </p>
              </PopoverContent>
            </Popover>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            {primary ? (
              <ContactBlock contact={primary} memberId={member.memberId} t={t} />
            ) : null}

            {secondary.length > 0 && (
              <>
                <Separator />
                <h3 className="text-sm font-medium text-muted-foreground">
                  {t('sections.secondary')}
                </h3>
                {secondary.map((c, i) => (
                  <div key={c.contactId} className="flex flex-col gap-6">
                    {i > 0 ? <Separator /> : null}
                    <ContactBlock
                      contact={c}
                      memberId={member.memberId}
                      t={t}
                    />
                  </div>
                ))}
              </>
            )}
          </CardContent>
        </Card>

        {/* US7 AS1 — Invoice history on member page. Wrapped in its
            own Suspense boundary so member metadata + contacts paint
            first and an invoice-fetch failure stays isolated to this
            section (parent page's `getMember` call is unaffected). */}
        {(session.user.role === 'admin' || session.user.role === 'manager') && (
          <Suspense fallback={<MemberInvoicesSkeleton />}>
            <MemberInvoicesSection
              tenant={tenant}
              memberId={member.memberId}
              role={session.user.role}
              statusFilter={invStatus}
              fiscalYearFilter={invYear}
              searchFilter={invQ}
            />
          </Suspense>
        )}
    </DetailContainer>
  );
}
