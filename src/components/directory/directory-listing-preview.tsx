'use client';

/**
 * Directory listing preview — how the member's entry will appear in the
 * published directory (E-Book / JSON), rendered from the settings form's
 * CURRENT (possibly unsaved) state.
 *
 * Runs the same pure SC-007 projection the export worker uses
 * (`projectPublishedListing`), so what the member sees is exactly what the
 * published output would carry: only fields toggled on, a hidden email shown
 * as "contact via the chamber", an unlisted member not at all. The heading
 * says "Preview of unsaved changes" while the form differs from what is saved.
 *
 * Pure domain values come from the client-safe `@/modules/insights/constants`
 * entry — never the server-only barrel.
 */
import { useTranslations } from 'next-intl';
import { AuraCard } from '@/components/shell/aura-markup';
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

  const location = published?.location
    ? [published.location.city, published.location.country].filter(Boolean).join(', ')
    : null;

  return (
    // An AURA card; the heading stays in its own live region (it flips to
    // "Preview of unsaved changes"), so it is drawn here, not as the card title.
    <AuraCard aria-labelledby="dir-preview-heading" data-testid="directory-listing-preview">
      <div aria-live="polite">
        <h2 id="dir-preview-heading" className="aura-card__title">
          {dirty ? t('previewUnsaved') : t('previewHeading')}
        </h2>
      </div>
      <p className="mb-3 text-sm text-[var(--aura-fg-secondary)]">{t('previewHint')}</p>
      <div className="rounded-[var(--aura-radius-md)] border border-[var(--aura-border-default)] p-4">
        {!state.listed ? (
          <p className="text-sm text-[var(--aura-fg-secondary)]">{t('previewNotListed')}</p>
        ) : published === null ? (
          <p className="text-sm text-[var(--aura-fg-secondary)]">{t('previewEmpty')}</p>
        ) : (
          <div className="flex gap-4">
            {published.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- public Blob URL, same as the logo control's preview
              <img
                src={published.logoUrl}
                alt=""
                className="size-16 shrink-0 rounded object-contain"
              />
            ) : null}
            <div className="min-w-0 space-y-1 text-sm">
              {published.name ? <p className="font-semibold">{published.name}</p> : null}
              {published.tier ? <p className="text-[var(--aura-fg-secondary)]">{published.tier}</p> : null}
              {published.industry ? <p>{published.industry}</p> : null}
              {published.description ? <p>{published.description}</p> : null}
              {published.website ? <p className="break-all">{published.website}</p> : null}
              {location ? <p>{location}</p> : null}
              {published.contact ? (
                <p data-testid="directory-preview-contact">
                  {[
                    published.contact.name,
                    published.contact.email,
                    published.contact.contactForm ? t('previewContactForm') : undefined,
                  ]
                    .filter(Boolean)
                    .join(' — ')}
                </p>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </AuraCard>
  );
}
