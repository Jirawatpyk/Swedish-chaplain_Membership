'use client';

/**
 * Directory listing preview — how the member's entry will appear in the
 * published directory (E-Book / JSON), rendered from the settings form's
 * CURRENT (possibly unsaved) state.
 *
 * Runs the same pure SC-007 projection the export worker uses
 * (`projectPublishedListing`), so what the member sees is exactly what the
 * published output would carry: only fields toggled on, a hidden email shown
 * as "contact via the chamber", an unlisted member not at all. A badge says
 * "Preview of unsaved changes" while the form differs from what is saved.
 *
 * Spec 122 US3 (`Portal-directory`): an aside with a mono label over the
 * card; the card reads like the E-Book entry — logo tile, name, "tier ·
 * industry", description, "city, country · website", contact.
 *
 * Pure domain values come from the client-safe `@/modules/insights/constants`
 * entry — never the server-only barrel.
 */
import { useLocale, useTranslations } from 'next-intl';
import i18nIsoCountries from 'i18n-iso-countries';
import { Badge, Card } from '@jirawatpyk/aura-react/server';
import { isLocaleRegistered } from '@/components/members/country-display';
import { safeExternalHref } from '@/lib/safe-url';
import {
  projectPublishedListing,
  type FieldVisibility,
} from '@/modules/insights/constants';

export interface DirectoryPreviewState {
  readonly listed: boolean;
  readonly fieldVisibility: FieldVisibility;
  readonly industry: string;
  readonly description: string;
  readonly website: string;
  readonly locationCity: string;
  readonly locationCountry: string;
}

export interface DirectoryPreviewIdentity {
  readonly companyName: string;
  readonly tier: string | null;
  readonly logoUrl: string | null;
  /** The member's live primary contact — the only contact the directory publishes. */
  readonly primaryContact: { readonly name: string; readonly email: string } | null;
}

/** The host to show for a link ("lindqvist.example"); the text as typed when it won't parse (e.g. "https://" alone). */
function hostOf(href: string): string {
  try {
    return new URL(href).host || href;
  } catch {
    return href;
  }
}

function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function DirectoryListingPreview({
  state,
  identity,
  dirty,
}: {
  readonly state: DirectoryPreviewState;
  readonly identity: DirectoryPreviewIdentity;
  readonly dirty: boolean;
}): React.JSX.Element {
  const t = useTranslations('directorySettings');

  const published = projectPublishedListing({
    listed: state.listed,
    fieldVisibility: state.fieldVisibility,
    identity: {
      memberName: identity.companyName,
      tier: identity.tier,
      contactName: identity.primaryContact?.name ?? null,
      contactEmail: identity.primaryContact?.email ?? null,
    },
    metadata: {
      industry: orNull(state.industry),
      description: orNull(state.description),
      website: orNull(state.website),
      logoUrl: identity.logoUrl,
      locationCity: orNull(state.locationCity),
      locationCountry: orNull(state.locationCountry),
    },
  });

  const locale = useLocale().split('-')[0] ?? 'en';
  // Display only: the listing stores the ISO code; the name when the locale's
  // names are loaded (the country field loads them), else the code.
  const countryName = (code: string | null | undefined) =>
    code ? ((isLocaleRegistered(locale) && i18nIsoCountries.getName(code, locale)) || code) : null;
  const location = published?.location
    ? [published.location.city, countryName(published.location.country)].filter(Boolean).join(', ')
    : null;
  const websiteHref = published?.website ? (safeExternalHref(published.website) ?? null) : null;
  const websiteText = websiteHref ? hostOf(websiteHref) : (published?.website ?? null);
  const meta = published ? [published.tier, published.industry].filter(Boolean).join(' · ') : '';

  return (
    <aside className="flex min-w-0 flex-col gap-2.5" aria-labelledby="dir-preview-heading" data-testid="directory-listing-preview">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h2 id="dir-preview-heading" className="m-0 font-mono text-[11px] font-normal tracking-[0.04em] text-[var(--aura-fg-tertiary)] uppercase">
          {t('previewLabel')}
        </h2>
        <span aria-live="polite">{dirty ? <Badge variant="outline">{t('previewUnsaved')}</Badge> : null}</span>
      </div>
      <Card>
        {!state.listed ? (
          <p className="text-sm text-[var(--aura-fg-secondary)]">{t('previewNotListed')}</p>
        ) : published === null ? (
          <p className="text-sm text-[var(--aura-fg-secondary)]">{t('previewEmpty')}</p>
        ) : (
          <div className="flex flex-col gap-3 text-[13px]">
            <div className="flex items-center gap-3">
              {published.logoUrl ? (
                <span className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-[var(--aura-radius-lg)] border border-[var(--aura-border-default)] bg-white p-1">
                  {/* eslint-disable-next-line @next/next/no-img-element -- public Blob URL, same as the logo control's preview */}
                  <img src={published.logoUrl} alt="" className="size-full object-contain" />
                </span>
              ) : null}
              <div className="min-w-0">
                {published.name ? <p className="text-sm font-semibold">{published.name}</p> : null}
                {meta ? <p className="text-xs text-[var(--aura-fg-secondary)]">{meta}</p> : null}
              </div>
            </div>
            {published.description ? <p>{published.description}</p> : null}
            {location || websiteText ? (
              <p className="text-[var(--aura-fg-secondary)] [overflow-wrap:anywhere]">
                {location}
                {location && websiteText ? ' · ' : null}
                {websiteHref ? (
                  <a href={websiteHref} target="_blank" rel="noopener noreferrer" className="text-[var(--aura-fg-accent)] no-underline hover:underline">
                    {websiteText}
                  </a>
                ) : (
                  websiteText
                )}
              </p>
            ) : null}
            {published.contact ? (
              <p data-testid="directory-preview-contact">
                {[published.contact.name, published.contact.email].filter(Boolean).join(' · ')}
                {published.contact.contactForm ? (
                  <span className="text-[var(--aura-fg-secondary)]">
                    {published.contact.name || published.contact.email ? ' · ' : null}
                    {t('previewContactForm')}
                  </span>
                ) : null}
              </p>
            ) : null}
          </div>
        )}
      </Card>
    </aside>
  );
}
