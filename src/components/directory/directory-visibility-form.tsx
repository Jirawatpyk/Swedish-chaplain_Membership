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
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
// TYPE-ONLY import from the insights barrel. A *value* import here (the
// previous `DEFAULT_FIELD_VISIBILITY` / `DIRECTORY_FIELDS` /
// `MAX_DIRECTORY_DESCRIPTION_LENGTH`) pulled the barrel's server-only runtime
// (postgres → fs/net, @node-rs/argon2, pino → worker_threads, revalidateTag)
// into this `'use client'` bundle and 500'd /portal/profile/directory once
// FEATURE_F9_DASHBOARD was on. Those pure constants are now passed as props
// from the server page (Principle III blocks a deep `insights/domain` import).
import type {
  DirectoryField,
  FieldVisibility,
  UpdateDirectoryListingError,
} from '@/modules/insights';
import { readErrorCode } from './read-error-code';

export interface DirectoryVisibilityFormInitial {
  readonly listed: boolean;
  readonly fieldVisibility: FieldVisibility;
  readonly industry: string | null;
  readonly description: string | null;
  readonly website: string | null;
  readonly locationCity: string | null;
  readonly locationCountry: string | null;
}

export function DirectoryVisibilityForm({
  initial,
  directoryFields,
  defaultFieldVisibility,
  maxDescriptionLength,
}: {
  readonly initial: DirectoryVisibilityFormInitial;
  /** Pure directory constants passed from the server page so this client
   *  component does not import them as runtime values from the server-laden
   *  insights barrel (see the type-only import note above). */
  readonly directoryFields: readonly DirectoryField[];
  readonly defaultFieldVisibility: Record<DirectoryField, boolean>;
  readonly maxDescriptionLength: number;
}): React.JSX.Element {
  const t = useTranslations('directorySettings');
  const tf = useTranslations('directorySettings.fields');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [listed, setListed] = useState(initial.listed);
  const [vis, setVis] = useState<Record<DirectoryField, boolean>>(() => {
    const base: Record<DirectoryField, boolean> = { ...defaultFieldVisibility };
    for (const f of directoryFields) {
      const v = initial.fieldVisibility[f];
      if (v !== undefined) base[f] = v;
    }
    return base;
  });
  const [industry, setIndustry] = useState(initial.industry ?? '');
  const [description, setDescription] = useState(initial.description ?? '');
  const [website, setWebsite] = useState(initial.website ?? '');
  const [city, setCity] = useState(initial.locationCity ?? '');
  const [country, setCountry] = useState(initial.locationCountry ?? '');
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
            fieldVisibility: vis,
            industry: industry.trim() || null,
            description: description.trim() || null,
            website: website.trim() || null,
            locationCity: city.trim() || null,
            locationCountry: country.trim() || null,
          }),
        });
        if (!res.ok) {
          const code = await readErrorCode<UpdateDirectoryListingError>(res);
          if (code === 'invalid_website') setWebsiteError(t('invalidWebsite'));
          else if (code === 'description_too_long') setDescriptionError(t('descriptionTooLong'));
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
          <Switch id="dir-listed" checked={listed} onCheckedChange={setListed} />
          <Label htmlFor="dir-listed">{t('listed')}</Label>
        </div>
        <p className="text-sm text-muted-foreground">{t('listedHint')}</p>
      </div>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-semibold">{t('fieldsHeading')}</legend>
        {directoryFields.map((f) => (
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
            maxLength={maxDescriptionLength}
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
              {description.length}/{maxDescriptionLength}
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

      <Button type="submit" disabled={pending}>
        {t('save')}
      </Button>
    </form>
  );
}
