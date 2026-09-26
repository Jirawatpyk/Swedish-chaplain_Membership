'use client';

/**
 * F9 US5 (T082b) — member directory listing settings form (FR-025).
 *
 * Member controls their listing: the listed toggle, per-field visibility for the
 * fixed `DIRECTORY_FIELDS` set (email default-hidden), and the directory
 * metadata (industry/description/website/location). Posts to the member-own
 * route; toasts the result (ux-standards § 5). The logo is managed separately.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  ActionBar,
  Button,
  Checkbox,
  FormErrorSummary,
  Switch,
  TextField,
  Textarea,
  type FormErrorItem,
} from '@jirawatpyk/aura-react';
import { toast } from '@/lib/toast';
import { useReadOnlyToast } from '@/components/shell/use-read-only-toast';
import { isReadOnlyResponse } from '@/lib/http/read-only-refusal';
import { AuraAlert, AuraCard } from '@/components/shell/aura-markup';
// Pure directory constants come from the insights CLIENT-SAFE sub-entry
// (`@/modules/insights/constants`), never the index barrel. Importing these
// runtime values from `@/modules/insights` would drag the barrel's server-only
// runtime (postgres → fs/net, @node-rs/argon2, pino → worker_threads,
// revalidateTag) into this `'use client'` bundle and 500 /portal/profile/
// directory once FEATURE_F9_DASHBOARD is on. `UpdateDirectoryListingError` is a
// type-only import (erased at compile, so no runtime leak).
import {
  DEFAULT_FIELD_VISIBILITY,
  DIRECTORY_FIELDS,
  MAX_DIRECTORY_DESCRIPTION_LENGTH,
  effectiveContactVisibility,
  type DirectoryField,
  type FieldVisibility,
} from '@/modules/insights/constants';
import type { UpdateDirectoryListingError } from '@/modules/insights';
import { readErrorCode } from './read-error-code';
import {
  DirectoryListingPreview,
  type DirectoryPreviewIdentity,
} from './directory-listing-preview';

/** The toggles that publish the member's primary contact's personal data. */
const CONTACT_FIELDS = ['contact_name', 'contact_email'] as const;
type ContactField = (typeof CONTACT_FIELDS)[number];
const COMPANY_FIELDS = DIRECTORY_FIELDS.filter(
  (f): f is Exclude<DirectoryField, ContactField> =>
    !(CONTACT_FIELDS as readonly string[]).includes(f),
);

export interface DirectoryVisibilityFormInitial {
  readonly listed: boolean;
  readonly fieldVisibility: FieldVisibility;
  readonly industry: string | null;
  readonly description: string | null;
  readonly website: string | null;
  readonly locationCity: string | null;
  readonly locationCountry: string | null;
}

/**
 * Whose contact details the listing publishes, and whether this viewer may
 * decide (GDPR Art. 6 / PDPA §19, §24 — only the live primary contact; the
 * server enforces it, this only mirrors it).
 */
export interface DirectoryContactContext {
  readonly viewerIsPrimary: boolean;
  /**
   * The stored contact toggles were chosen by today's primary contact. When
   * false the published output uses the defaults (name shown, email hidden)
   * until the primary saves (`effectiveContactVisibility`).
   */
  readonly chosenByPrimary: boolean;
  /** A listing row exists (a new listing starts from the defaults). */
  readonly hasListing: boolean;
}

export function DirectoryVisibilityForm({
  initial,
  contact,
  identity,
}: {
  readonly initial: DirectoryVisibilityFormInitial;
  readonly contact: DirectoryContactContext;
  readonly identity: DirectoryPreviewIdentity;
}): React.JSX.Element {
  const t = useTranslations('directorySettings');
  const tc = useTranslations('common');
  const readOnlyToast = useReadOnlyToast();
  const tf = useTranslations('directorySettings.fields');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const canChooseContact = contact.viewerIsPrimary && identity.primaryContact !== null;
  // What is STORED for the contact toggles (absent = hidden) — a colleague
  // always resubmits these unchanged, so an unsaved default can never trip the
  // server's primary-only gate.
  const storedContact: Record<ContactField, boolean> = {
    contact_name: initial.fieldVisibility.contact_name === true,
    contact_email: initial.fieldVisibility.contact_email === true,
  };

  const [initialVis] = useState<Record<DirectoryField, boolean>>(() => {
    const base: Record<DirectoryField, boolean> = { ...DEFAULT_FIELD_VISIBILITY };
    for (const f of DIRECTORY_FIELDS) {
      const v = initial.fieldVisibility[f];
      if (v !== undefined) base[f] = v;
    }
    // The contact toggles show what the directory actually publishes: the
    // stored choice, or — when a previous primary made it — the defaults
    // (`effectiveContactVisibility`). A new listing starts from the defaults
    // only for the primary, who is the one choosing.
    const start: FieldVisibility = contact.hasListing
      ? storedContact
      : canChooseContact
        ? DEFAULT_FIELD_VISIBILITY
        : {};
    const shown =
      contact.hasListing && !contact.chosenByPrimary
        ? effectiveContactVisibility(start, null, null)
        : start;
    for (const f of CONTACT_FIELDS) base[f] = shown[f] === true;
    return base;
  });
  const [listed, setListed] = useState(initial.listed);
  const [vis, setVis] = useState<Record<DirectoryField, boolean>>(initialVis);
  const [industry, setIndustry] = useState(initial.industry ?? '');
  const [description, setDescription] = useState(initial.description ?? '');
  const [website, setWebsite] = useState(initial.website ?? '');
  const [city, setCity] = useState(initial.locationCity ?? '');
  const [country, setCountry] = useState(initial.locationCountry ?? '');

  const dirty =
    listed !== initial.listed ||
    DIRECTORY_FIELDS.some((f) => vis[f] !== initialVis[f]) ||
    industry !== (initial.industry ?? '') ||
    description !== (initial.description ?? '') ||
    website !== (initial.website ?? '') ||
    city !== (initial.locationCity ?? '') ||
    country !== (initial.locationCountry ?? '');
  const [websiteError, setWebsiteError] = useState<string | null>(null);
  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  // Bumped on every save so the error summary takes focus after a refused
  // save, never while the person types (AURA 5.7.3 `focusKey`).
  const [submitCount, setSubmitCount] = useState(0);
  const errors: FormErrorItem[] = [
    ...(descriptionError !== null ? [{ field: 'dir-description', message: descriptionError }] : []),
    ...(websiteError !== null ? [{ field: 'dir-website', message: websiteError }] : []),
  ];

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitCount((n) => n + 1);
    startTransition(async () => {
      try {
        setWebsiteError(null);
        setDescriptionError(null);
        const res = await fetch('/api/portal/directory', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            listed,
            fieldVisibility: canChooseContact ? vis : { ...vis, ...storedContact },
            industry: industry.trim() || null,
            description: description.trim() || null,
            website: website.trim() || null,
            locationCity: city.trim() || null,
            locationCountry: country.trim() || null,
          }),
        });
        if (!res.ok) {
          if (await isReadOnlyResponse(res)) {
            readOnlyToast();
            return;
          }
          const code = await readErrorCode<UpdateDirectoryListingError>(res);
          if (code === 'invalid_website') setWebsiteError(t('invalidWebsite'));
          else if (code === 'description_too_long') setDescriptionError(t('descriptionTooLong'));
          else if (code === 'not_primary_contact') toast.error(t('notPrimaryContact'));
          else toast.error(t('saveFailed'));
          return;
        }
        toast.success(t('saved'));
        router.refresh();
      } catch {
        toast.error(t('saveFailed'));
      }
    });
  }

  // Spec 122 US3 (`Portal-directory`): one AURA card per group, each
  // fieldset named by its card title; Save sits in an ActionBar that says
  // "Unsaved changes" while the form differs from what is saved, so it stays
  // in reach while scrolling on a phone.
  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <FormErrorSummary errors={errors} focusKey={submitCount} />

      <AuraCard title={t('listed')} titleId="dir-listed-heading" headingLevel={2}>
        <Switch
          id="dir-listed"
          label={t('listed')}
          description={t('listedHint')}
          checked={listed}
          onChange={setListed}
        />
      </AuraCard>

      <AuraCard title={t('fieldsHeading')} titleId="dir-fields-heading" headingLevel={2}>
        <fieldset aria-labelledby="dir-fields-heading" className="flex flex-col gap-3">
          {COMPANY_FIELDS.map((f) => (
            <Checkbox
              key={f}
              checked={vis[f]}
              onChange={(c) => setVis((prev) => ({ ...prev, [f]: c }))}
            >
              {tf(f)}
            </Checkbox>
          ))}
        </fieldset>
      </AuraCard>

      <AuraCard title={t('contactHeading')} titleId="dir-contact-heading" headingLevel={2}>
        <fieldset
          aria-labelledby="dir-contact-heading"
          aria-describedby="dir-contact-hint"
          className="flex flex-col gap-3"
        >
          {contact.viewerIsPrimary && !contact.chosenByPrimary && contact.hasListing ? (
            <AuraAlert
              tone="info"
              role="status"
              title={t('contactConfirmTitle')}
              data-testid="directory-contact-confirm"
            >
              {t('contactConfirmBody')}
            </AuraAlert>
          ) : null}
          {CONTACT_FIELDS.map((f) => {
            // Say exactly whose data the toggle publishes.
            const label =
              identity.primaryContact === null
                ? tf(f)
                : f === 'contact_name'
                  ? t('contactNameLabel', { name: identity.primaryContact.name })
                  : t('contactEmailLabel', { email: identity.primaryContact.email });
            return (
              <Checkbox
                key={f}
                checked={vis[f]}
                disabled={!canChooseContact}
                onChange={(c) => setVis((prev) => ({ ...prev, [f]: c }))}
              >
                {label}
              </Checkbox>
            );
          })}
          <p id="dir-contact-hint" className="text-sm text-[var(--aura-fg-secondary)]">
            {identity.primaryContact === null
              ? t('contactHintNoPrimary')
              : contact.viewerIsPrimary
                ? t('contactHintPrimary')
                : t('contactHintColleague', { name: identity.primaryContact.name })}
          </p>
        </fieldset>
      </AuraCard>

      <AuraCard title={t('detailsHeading')} titleId="dir-details-heading" headingLevel={2}>
        <fieldset aria-labelledby="dir-details-heading" className="flex flex-col gap-4">
          <TextField
            id="dir-industry"
            label={t('industry')}
            value={industry}
            onChange={(e) => setIndustry(e.target.value)}
          />
          <div>
            <Textarea
              id="dir-description"
              label={t('description')}
              value={description}
              maxLength={MAX_DIRECTORY_DESCRIPTION_LENGTH}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              error={descriptionError ?? undefined}
              aria-describedby="dir-description-count"
            />
            <p
              id="dir-description-count"
              aria-live="polite"
              className="mt-1 text-right text-xs text-[var(--aura-fg-secondary)]"
            >
              {description.length}/{MAX_DIRECTORY_DESCRIPTION_LENGTH}
            </p>
          </div>
          <TextField
            id="dir-website"
            type="url"
            label={t('website')}
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            placeholder="https://"
            error={websiteError ?? undefined}
          />
          <div className="flex flex-col gap-4 sm:flex-row">
            <TextField
              id="dir-city"
              className="flex-1"
              label={t('city')}
              value={city}
              onChange={(e) => setCity(e.target.value)}
            />
            <TextField
              id="dir-country"
              className="flex-1"
              label={t('country')}
              value={country}
              maxLength={2}
              onChange={(e) => setCountry(e.target.value.toUpperCase())}
            />
          </div>
        </fieldset>
      </AuraCard>

      <DirectoryListingPreview
        dirty={dirty}
        identity={identity}
        state={{
          listed,
          fieldVisibility: vis,
          industry,
          description,
          website,
          locationCity: city,
          locationCountry: country,
        }}
      />

      <ActionBar status={dirty ? tc('unsavedStatus') : null}>
        <Button type="submit" loading={pending}>
          {t('save')}
        </Button>
      </ActionBar>
    </form>
  );
}
