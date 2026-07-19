/**
 * Task 6 — "Branding" settings section (logo upload).
 *
 * Mechanical extraction from `invoice-settings-form.tsx`'s Logo
 * fieldset — field JSX moved verbatim. The upload itself is a
 * separate side-effecting POST (`onLogoChange`, owned by the
 * orchestrator) that fires on file-select and reports back via
 * `uploadingLogo` / `logoError` / `logoBlobKey`; this component only
 * renders that state, it never calls the upload endpoint itself.
 *
 * Controlled + presentational only: no local field state, no upload
 * logic, no validation logic.
 */
'use client';

import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface BrandingSectionProps {
  readonly logoBlobKey: string | null;
  readonly uploadingLogo: boolean;
  readonly logoError: string | null;
  readonly onLogoChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  readonly disabled: boolean;
}

export function BrandingSection({
  logoBlobKey,
  uploadingLogo,
  logoError,
  onLogoChange,
  disabled,
}: BrandingSectionProps) {
  const t = useTranslations('admin.invoiceSettings');

  return (
    <section
      id="branding"
      aria-labelledby="branding-heading"
      className="flex flex-col gap-[var(--page-section-gap)]"
    >
      <h2
        id="branding-heading"
        data-section-heading
        tabIndex={-1}
        className="font-heading text-base font-semibold"
      >
        {t('sections.branding')}
      </h2>

      {/* Logo */}
      <fieldset className="flex flex-col gap-4 rounded-md border p-4">
        <legend className="px-2 text-sm font-semibold">
          {t('sections.logo')}
        </legend>
        <div className="space-y-2">
          <Label htmlFor="logo_file">{t('labels.logo')}</Label>
          <Input
            id="logo_file"
            type="file"
            accept="image/png,image/jpeg"
            onChange={onLogoChange}
            disabled={disabled || uploadingLogo}
            aria-describedby="logo_hint logo_status"
            className="cursor-pointer file:cursor-pointer hover:bg-accent/40"
          />
          <p id="logo_hint" className="text-xs text-muted-foreground">
            {t('hints.logo')}
          </p>
          <p id="logo_status" className="text-xs" aria-live="polite">
            {uploadingLogo ? (
              <span className="text-muted-foreground">{t('logo.uploading')}</span>
            ) : logoBlobKey ? (
              <span className="text-muted-foreground">
                {t('logo.currentKey')}: <span className="font-mono">{logoBlobKey}</span>
              </span>
            ) : null}
          </p>
          {logoError ? (
            <p className="text-sm text-destructive" role="alert">
              {logoError}
            </p>
          ) : null}
        </div>
      </fieldset>
    </section>
  );
}
