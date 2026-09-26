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
import { Loader2Icon } from 'lucide-react';
import { toast } from '@/lib/toast';
import { useReadOnlyToast } from '@/components/shell/use-read-only-toast';
import { isReadOnlyResponse } from '@/lib/http/read-only-refusal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  InlineAlert,
  InlineAlertDescription,
  InlineAlertTitle,
} from '@/components/ui/inline-alert';
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

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
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

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <div className="space-y-1">
        <div className="flex items-center gap-3">
          {/* aria-label in addition to the <Label>: the base-ui Switch renders
              its own internal id, so htmlFor="dir-listed" doesn't reliably
              associate → no accessible name (axe aria-toggle-field-name, WCAG
              4.1.2). The explicit aria-label guarantees the SR name regardless,
              matching the field-checkbox pattern below. */}
          <Switch
            id="dir-listed"
            checked={listed}
            onCheckedChange={setListed}
            aria-label={t('listed')}
          />
          <Label htmlFor="dir-listed">{t('listed')}</Label>
        </div>
        <p className="text-sm text-muted-foreground">{t('listedHint')}</p>
      </div>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-semibold">{t('fieldsHeading')}</legend>
        {COMPANY_FIELDS.map((f) => (
          <label key={f} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={vis[f]}
              onCheckedChange={(c) => setVis((prev) => ({ ...prev, [f]: c === true }))}
              aria-label={tf(f)}
            />
            {tf(f)}
          </label>
        ))}
      </fieldset>

      <fieldset className="space-y-2" aria-describedby="dir-contact-hint">
        <legend className="mb-1 text-sm font-semibold">{t('contactHeading')}</legend>
        {contact.viewerIsPrimary && !contact.chosenByPrimary && contact.hasListing ? (
          <InlineAlert tone="info" role="status" data-testid="directory-contact-confirm">
            <InlineAlertTitle>{t('contactConfirmTitle')}</InlineAlertTitle>
            <InlineAlertDescription>{t('contactConfirmBody')}</InlineAlertDescription>
          </InlineAlert>
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
            <label
              key={f}
              className={`flex items-center gap-2 text-sm${canChooseContact ? '' : ' text-muted-foreground'}`}
            >
              <Checkbox
                checked={vis[f]}
                disabled={!canChooseContact}
                onCheckedChange={(c) => setVis((prev) => ({ ...prev, [f]: c === true }))}
                aria-label={label}
              />
              {label}
            </label>
          );
        })}
        <p id="dir-contact-hint" className="text-sm text-muted-foreground">
          {identity.primaryContact === null
            ? t('contactHintNoPrimary')
            : contact.viewerIsPrimary
              ? t('contactHintPrimary')
              : t('contactHintColleague', { name: identity.primaryContact.name })}
        </p>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="mb-1 text-sm font-semibold">{t('detailsHeading')}</legend>
        <div className="space-y-1">
          <Label htmlFor="dir-industry">{t('industry')}</Label>
          <Input id="dir-industry" value={industry} onChange={(e) => setIndustry(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="dir-description">{t('description')}</Label>
          <Textarea
            id="dir-description"
            value={description}
            maxLength={MAX_DIRECTORY_DESCRIPTION_LENGTH}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            aria-invalid={descriptionError !== null}
            aria-describedby={
              descriptionError !== null
                ? 'dir-description-count dir-description-error'
                : 'dir-description-count'
            }
          />
          <div className="flex items-center justify-between gap-2">
            {descriptionError !== null ? (
              <p id="dir-description-error" role="alert" className="text-sm text-destructive">
                {descriptionError}
              </p>
            ) : (
              <span />
            )}
            <p
              id="dir-description-count"
              aria-live="polite"
              className="text-sm text-muted-foreground"
            >
              {description.length}/{MAX_DIRECTORY_DESCRIPTION_LENGTH}
            </p>
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="dir-website">{t('website')}</Label>
          <Input
            id="dir-website"
            type="url"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            placeholder="https://"
            aria-invalid={websiteError !== null}
            aria-describedby={websiteError !== null ? 'dir-website-error' : undefined}
          />
          {websiteError !== null ? (
            <p id="dir-website-error" role="alert" className="text-sm text-destructive">
              {websiteError}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="flex-1 space-y-1">
            <Label htmlFor="dir-city">{t('city')}</Label>
            <Input id="dir-city" value={city} onChange={(e) => setCity(e.target.value)} />
          </div>
          <div className="flex-1 space-y-1">
            <Label htmlFor="dir-country">{t('country')}</Label>
            <Input
              id="dir-country"
              value={country}
              maxLength={2}
              onChange={(e) => setCountry(e.target.value.toUpperCase())}
            />
          </div>
        </div>
      </fieldset>

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

      <Button type="submit" disabled={pending}>
        {pending && <Loader2Icon className="mr-2 h-4 w-4 motion-safe:animate-spin" aria-hidden />}
        {t('save')}
      </Button>
    </form>
  );
}
