import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Alert, Badge, Card } from '@jirawatpyk/aura-react/server';
import { ChangePasswordForm } from '@/components/auth/change-password-form';
import { DataExportPanel, type DataExportRow } from '@/components/data-export/data-export-panel';
import { buildDataExportLabels } from '@/components/data-export/data-export-view-model';
import { PageHeader } from '@/components/layout/page-header';
import { ContactLanguageForm, type ContactLanguage } from '@/components/portal/contact-language-form';
import { PreferredLocaleForm } from '@/components/portal/preferred-locale-form';
import { RenewalRemindersToggle } from '@/app/(member)/portal/preferences/renewals/_components/renewal-reminders-toggle';

/**
 * `/portal/account` as the `Portal-account` boards draw it, once the page has
 * done its best-effort reads (spec 122 US3). Split from the page so the
 * preview harness renders the same markup from sample data; a plain async
 * function, like `renderPortalProfileView`.
 *
 * The boards' page: the caller's `DetailContainer` (the 1200px portal
 * column), the cards in an 880px column under the header, 16px apart. Section ids and h2s are the account
 * menu's deep links (`#account`, `#language`, `#renewal-prefs`,
 * `#data-privacy`).
 */
export interface PortalAccountViewProps {
  readonly email: string;
  /** The role badge's text (e.g. "Member"). */
  readonly roleLabel: string;
  /** undefined → the locale form fetches its own value. */
  readonly initialLocale: 'en' | 'th' | 'sv' | null | undefined;
  /** The caller's own contact language; null → no linked contact, no form. */
  readonly contactLanguage: ContactLanguage | null;
  /** Renewal preferences + Data & privacy write to the member row: hidden when unlinked. */
  readonly hasMember: boolean;
  readonly initialOptedOut: boolean;
  /** The F9 flag (and a linked member). */
  readonly showDataPrivacy: boolean;
  readonly exportsReadFailed: boolean;
  readonly exportRows: readonly DataExportRow[];
  /** The tenant's privacy contact and notice (both optional in env). */
  readonly privacyContactEmail: string | null;
  readonly privacyPolicyUrl: string | null;
}

export async function renderPortalAccountView({
  email,
  roleLabel,
  initialLocale,
  contactLanguage,
  hasMember,
  initialOptedOut,
  showDataPrivacy,
  exportsReadFailed,
  exportRows,
  privacyContactEmail,
  privacyPolicyUrl,
}: PortalAccountViewProps) {
  const tPage = await getTranslations('portal.account');
  const tLocale = await getTranslations('portal.preferredLocale');
  const tExport = await getTranslations('dataExport');
  const link = 'font-medium text-[var(--aura-fg-accent)] no-underline hover:text-[var(--aura-fg-primary)] hover:underline';

  return (
    <>
      <PageHeader title={tPage('title')} subtitle={tPage('subtitle')} badge={<Badge variant="outline">{roleLabel}</Badge>} />

      <div className="flex max-w-[880px] flex-col gap-4">
        <HubCard id="account" title={tPage('sections.account')} contentClassName="flex flex-col gap-4">
          <dl className="m-0">
            <div className="flex flex-col gap-0.5">
              <dt className="text-xs text-[var(--aura-fg-secondary)]">{tPage('emailLabel')}</dt>
              <dd className="m-0 text-sm [overflow-wrap:anywhere]">{email}</dd>
            </div>
          </dl>
          <div className="max-w-[480px]">
            <ChangePasswordForm
              showPasswordHint
              secondaryAction={
                <Link href="/forgot-password" className={`inline-flex min-h-11 items-center aura-text-label sm:min-h-0 ${link}`}>
                  {tPage('forgotPassword')}
                </Link>
              }
            />
          </div>
          <p className="text-xs text-[var(--aura-fg-secondary)]">{tPage('passwordSessionsNote')}</p>
        </HubCard>

        {/* The company's notification language and (F114 FR-004) the
            contact's own email language, side by side from 768px. The
            contact form is the ONE body the narrowed profile endpoint still
            accepts while the tenant requires approval for member changes. */}
        <HubCard id="language" title={tLocale('title')} contentClassName="grid gap-4 md:grid-cols-2 md:gap-8">
          <PreferredLocaleForm initialValue={initialLocale} />
          {contactLanguage ? (
            <div
              id="contact-language"
              className="border-[var(--aura-border-default)] max-md:border-t max-md:pt-4 md:border-l md:pl-8"
            >
              <ContactLanguageForm initialValue={contactLanguage} />
            </div>
          ) : null}
        </HubCard>

        {hasMember ? (
          <HubCard id="renewal-prefs" title={tPage('sections.renewalPrefs')}>
            <RenewalRemindersToggle initialOptedOut={initialOptedOut} />
          </HubCard>
        ) : null}

        {showDataPrivacy ? (
          <HubCard id="data-privacy" title={tPage('sections.dataPrivacy')} contentClassName="flex flex-col gap-4">
            <p className="text-sm text-[var(--aura-fg-secondary)]">{tExport('description')}</p>
            {/* GDPR Art. 15(4) · PDPA §30 — any colleague may request the member
                archive; it carries colleagues' names + roles (never their contact
                details), so say so before request / download. */}
            <Alert tone="info" role="status" title={tExport('colleaguesNoticeTitle')} data-testid="portal-export-colleagues-notice">
              {tExport('colleaguesNoticeBody')}
            </Alert>
            {exportsReadFailed ? (
              <Alert tone="danger" role="status" data-testid="portal-exports-unavailable">
                {tExport('loadFailed')}
              </Alert>
            ) : (
              <DataExportPanel rows={exportRows} labels={{ ...buildDataExportLabels(tExport), statusHeading: tExport('statusHeadingMember') }} />
            )}
            {/* The other data-subject rights (GDPR Art. 16–21 · PDPA §33–36):
                where to go for each. The contact and the notice only when the
                tenant has configured them — never a dead link. */}
            <div className="rounded-[var(--aura-radius-md)] bg-[var(--aura-bg-surface-hover)] px-3.5 py-3 aura-text-table-cell" data-testid="portal-other-data-requests">
              <p className="font-semibold">{tExport('otherRequests.title')}</p>
              <p className="mt-1 text-[var(--aura-fg-secondary)]">
                {tExport.rich('otherRequests.edit', {
                  edit: (chunks) => (
                    <Link href="/portal/edit" className={link}>
                      {chunks}
                    </Link>
                  ),
                })}{' '}
                {privacyContactEmail
                  ? tExport.rich('otherRequests.contact', {
                      address: privacyContactEmail,
                      mail: (chunks) => (
                        <a href={`mailto:${privacyContactEmail}`} className={`[overflow-wrap:anywhere] ${link}`}>
                          {chunks}
                        </a>
                      ),
                    })
                  : tExport('otherRequests.contactNoEmail')}
                {privacyPolicyUrl ? (
                  <>
                    {' '}
                    <a href={privacyPolicyUrl} target="_blank" rel="noreferrer" className={link}>
                      {tExport('otherRequests.privacyLink')}
                    </a>
                  </>
                ) : null}
              </p>
            </div>
          </HubCard>
        ) : null}
      </div>
    </>
  );
}

/**
 * One self-titled hub card: the scroll-anchored AURA card (`<section>`) whose
 * head carries a real `<h2>` title; the h2 `id` is `${id}-heading`.
 */
function HubCard({
  id,
  title,
  contentClassName,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly contentClassName?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <Card id={id} title={title} titleId={`${id}-heading`} headingLevel={2} className="scroll-mt-24">
      <div className={contentClassName}>{children}</div>
    </Card>
  );
}
