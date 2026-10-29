'use client';

/**
 * Board `Admin-settings-brand` — "How it looks in an E-Blast" (spec 122 US12a,
 * maintainer 18 Oct). A sample of the e-mail the brand settings produce, drawn
 * from the form as it is typed, before Save.
 *
 * The header and footer are the real e-mail's (`renderBroadcastHtml`,
 * `src/modules/broadcasts/infrastructure/resend/email-template.ts`): the logo,
 * or the chamber name when none is on file; then the footer lines from the
 * same `email.broadcastFooter` strings, with the postal address, or "Sent by …"
 * when there is none. The privacy-inbox line is left out, as on the board. The
 * colours are the e-mail's fixed light ones in both themes: every mail client
 * draws the message on white (the same call as the logo backing).
 *
 * Presentation only: no request, no state of its own. The button is a sample,
 * not a control, so it is a `span` and takes no focus.
 */
import { useId } from 'react';
import { useTranslations } from 'next-intl';

/**
 * The e-mail's own palette (`email-template.ts`), not app tokens. The footer
 * grey is #6b6b6b (5.3:1 on white), the e-mail's own since PR L.
 */
const EMAIL = {
  surface: '#ffffff',
  divider: '#eeeeee',
  footerText: '#6b6b6b',
  tenantName: '#666666',
} as const;

interface Props {
  readonly primaryColor: string;
  /** Normalised address; `null` when none is typed. */
  readonly postalAddress: string | null;
  readonly logoUrl: string | null;
  readonly tenantDisplayName: string;
}

export function BrandEmailPreview({
  primaryColor,
  postalAddress,
  logoUrl,
  tenantDisplayName,
}: Props): React.ReactElement {
  const t = useTranslations('admin.settings.broadcasts.brand.colour.preview');
  const f = useTranslations('email.broadcastFooter');
  const captionId = useId();

  return (
    <figure aria-labelledby={captionId} className="m-0 flex flex-col gap-2">
      <figcaption id={captionId} className="aura-text-caption text-[var(--aura-fg-secondary)]">{t('caption')}</figcaption>
      <div
        data-testid="brand-email-preview"
        className="overflow-hidden rounded-[var(--aura-radius-lg)] border border-[var(--aura-border-default)]"
        style={{ backgroundColor: EMAIL.surface }}
      >
        <div className="px-4 py-3" style={{ borderBottom: `1px solid ${EMAIL.divider}` }}>
          {logoUrl === null ? (
            <strong className="text-sm" style={{ color: EMAIL.tenantName }}>
              {tenantDisplayName}
            </strong>
          ) : (
            // A tenant-uploaded blob on an external host (see the logo card).
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt={tenantDisplayName} className="block h-auto max-h-12 max-w-60" />
          )}
        </div>
        <div className="flex flex-col items-start gap-3 px-4 py-5">
          <p className="text-xl font-semibold" style={{ color: primaryColor }}>
            {t('heading')}
          </p>
          <span
            className="inline-flex min-h-10 items-center rounded-[var(--aura-radius-md)] px-4 text-sm font-semibold text-white"
            style={{ backgroundColor: primaryColor }}
          >
            {t('button')}
          </span>
        </div>
        <div
          className="flex flex-col gap-1 px-4 py-3 text-xs leading-normal [overflow-wrap:anywhere]"
          style={{ borderTop: `1px solid ${EMAIL.divider}`, color: EMAIL.footerText }}
        >
          <p>{f('receivedBecause', { tenantDisplayName })}</p>
          <p>
            <span className="underline">{f('unsubscribeCta')}</span> {f('unsubscribeSuffix')}
          </p>
          <p className="whitespace-pre-line">
            {postalAddress ?? f('physicalAddress', { tenantDisplayName })}
          </p>
        </div>
      </div>
    </figure>
  );
}
