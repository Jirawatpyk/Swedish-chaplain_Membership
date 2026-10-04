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
 *
 * Spec 122 US8c-2 (T856) — an AURA card (board `Admin-invoice-settings`),
 * the rail's focus target. The logo keeps its native file input (in an AURA
 * `Field`, styled with AURA tokens): AURA's FileUpload would change the
 * upload trigger, and the upload request is unchanged. `#logo_hint`, the
 * `#logo_status` live region and the error's `role="alert"` stay.
 */
'use client';

import { useTranslations } from 'next-intl';
import { Card, Field } from '@jirawatpyk/aura-react';

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
    <Card
      as="section"
      id="branding"
      tabIndex={-1}
      className="scroll-mt-24 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--aura-focus-ring)]"
      title={t('sections.branding')}
      titleId="branding-heading"
      headingLevel={2}
    >
      {/* Logo */}
      <fieldset>
        <legend className="mb-[var(--aura-space-3)] text-sm font-semibold">{t('sections.logo')}</legend>
        <Field id="logo_file" label={t('labels.logo')} disabled={disabled || uploadingLogo}>
          <input
            id="logo_file"
            type="file"
            accept="image/png,image/jpeg"
            onChange={onLogoChange}
            disabled={disabled || uploadingLogo}
            aria-describedby="logo_hint logo_status"
            className="block min-h-11 w-full cursor-pointer text-sm text-[var(--aura-fg-secondary)] file:me-[var(--aura-space-3)] file:min-h-11 file:cursor-pointer file:rounded-[var(--aura-radius-md)] file:border file:border-solid file:border-[var(--aura-border-default)] file:bg-[var(--aura-bg-surface)] file:px-[var(--aura-space-4)] file:text-sm file:font-medium file:text-[var(--aura-fg-primary)] hover:file:bg-[var(--aura-bg-surface-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--aura-focus-ring)] disabled:cursor-not-allowed disabled:opacity-60"
          />
        </Field>
        <p id="logo_hint" className="mt-[var(--aura-space-2)] text-sm text-[var(--aura-fg-secondary)]">
          {t('hints.logo')}
        </p>
        <p id="logo_status" className="text-sm text-[var(--aura-fg-secondary)]" aria-live="polite">
          {uploadingLogo ? (
            t('logo.uploading')
          ) : logoBlobKey ? (
            <>
              {t('logo.currentKey')}:{' '}
              {/* Relay R34: a blob key is one unbroken token; at 200% text zoom
                  it overflowed the card, so it may break anywhere. */}
              <span className="font-mono [overflow-wrap:anywhere]">{logoBlobKey}</span>
            </>
          ) : null}
        </p>
        {logoError ? (
          <p className="text-sm text-[var(--aura-fg-danger)]" role="alert">
            {logoError}
          </p>
        ) : null}
      </fieldset>
    </Card>
  );
}
