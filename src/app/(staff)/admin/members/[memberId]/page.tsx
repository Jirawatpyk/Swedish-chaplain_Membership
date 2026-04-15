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
import { ArrowLeftIcon, PencilIcon } from 'lucide-react';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { headers } from 'next/headers';
import { getMember } from '@/modules/members';
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
import { ContentContainer } from '@/components/layout/content-container';
import { PageHeader } from '@/components/layout/page-header';
import { CopyButton } from '@/components/members/copy-button';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PageProps {
  readonly params: Promise<{ memberId: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { memberId } = await params;
  if (!UUID_RE.test(memberId)) return { title: 'Members · SweCham' };
  return { title: `Member · SweCham` };
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
  t,
}: {
  contact: Contact;
  t: Awaited<ReturnType<typeof getTranslations<'admin.members.detail'>>>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {`${contact.firstName} ${contact.lastName}`.trim()}
          {contact.isPrimary && (
            <Badge className="ml-2" variant="default">
              {t('sections.primary')}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
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
      </CardContent>
    </Card>
  );
}

export default async function MemberDetailPage({ params }: PageProps) {
  const { memberId } = await params;
  if (!UUID_RE.test(memberId)) notFound();

  await requireSession('staff');
  const tenant = resolveTenantFromRequest();
  const h = await headers();
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
        <ContentContainer>
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
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                <ArrowLeftIcon className="size-4" />
                {t('notFound.cta')}
              </Link>
            </CardContent>
          </Card>
        </ContentContainer>
      );
    }
    // Generic server error — let the route-level error.tsx handle unknowns.
    throw new Error(`getMember failed: ${result.error.message}`);
  }

  const { member, contacts } = result.value;
  const primary = contacts.find((c) => c.isPrimary && c.removedAt === null);
  const secondary = contacts.filter(
    (c) => !c.isPrimary && c.removedAt === null,
  );

  return (
    <ContentContainer>
      <PageHeader
        title={member.companyName}
        subtitle={tRoot('subtitle')}
        actions={
          <>
            <Link
              href="/admin/members"
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              <ArrowLeftIcon className="size-4" />
              {t('notFound.cta')}
            </Link>
            <Link
              href={`/admin/members/${member.memberId}/edit`}
              className={buttonVariants({ size: 'sm' })}
            >
              <PencilIcon className="size-4" />
              Edit
            </Link>
          </>
        }
      />

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('sections.company')}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2 lg:grid-cols-3">
              <Field
                label="Member ID"
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
                label={t('fields.planId')}
                value={member.planId}
                mono
              />
              <Field label={t('fields.planYear')} value={member.planYear} />
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

        <h2 className="text-h3 text-lg font-semibold mt-4">
          {t('sections.contacts')}
        </h2>

        {primary ? <ContactBlock contact={primary} t={t} /> : null}

        {secondary.length > 0 && (
          <>
            <h3 className="text-sm font-medium text-muted-foreground">
              {t('sections.secondary')}
            </h3>
            {secondary.map((c) => (
              <ContactBlock key={c.contactId} contact={c} t={t} />
            ))}
          </>
        )}
      </div>
    </ContentContainer>
  );
}
