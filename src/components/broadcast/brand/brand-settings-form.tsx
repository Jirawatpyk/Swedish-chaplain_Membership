'use client';

/**
 * F119 T030 — the chamber brand form on `/admin/settings/broadcasts/brand`
 * (FR-041b/c; contracts/admin-eblast-formatting-api.md § brand).
 *
 * Three fields with three different contracts:
 *
 *   - **Colour** — writable, and the one field whose refusal is predictable
 *     before the round-trip. `PATCH` answers 422 `colour_contrast` when white
 *     text on the colour is below WCAG AA 4.5:1, so the readout states the
 *     measured ratio live and Save is disabled below the threshold: the
 *     refusal is never a surprise. The arithmetic is the Domain's own
 *     (`contrastRatioOnWhite`), reached through `@/lib/brand-settings-client`
 *     — a second copy would drift from what the server refuses with.
 *   - **Postal address** — writable, free text, line breaks allowed, 300
 *     characters the only bound (FR-041c). Empty is a legitimate state of the
 *     world, so it reads as a `role="status"` NOTICE, never a field error, and
 *     it does not block Save.
 *   - **Logo** — READ-only here. It belongs to `tenant_invoice_settings`
 *     (super-admin only); `PATCH` accepts no logo key at all. A holder of
 *     `settings.invoicing` gets the Manage link; everyone else is told to ask
 *     an administrator, because a control a user cannot operate is worse than
 *     a sentence telling them who can.
 *
 * The colour is applied to **e-mail only** (FR-041c) — never to the admin or
 * member portal chrome. Nothing here writes a CSS variable or a theme token;
 * the one place it is rendered is the swatch beside the field, which is a
 * preview of the e-mail button, not app chrome.
 */
import Link from 'next/link';
import { useId, useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { InfoIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { InlineAlert, InlineAlertDescription } from '@/components/ui/inline-alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  AA_MIN_CONTRAST,
  BRAND_POSTAL_ADDRESS_MAX,
  contrastRatioOnWhite,
  parseBrandPrimaryColor,
} from '@/lib/brand-settings-client';
import type { BrandSettingsView } from '@/modules/broadcasts';

const BRAND_ENDPOINT = '/api/admin/broadcasts/brand';

interface Props {
  readonly initial: BrandSettingsView;
}

interface ApiErrorBody {
  readonly error?: {
    readonly code?: string;
    readonly details?: { readonly ratio?: number; readonly required?: number; readonly retryAfterSeconds?: number };
  };
}

/** The address as the Domain will store it — CRLF folded, trimmed. */
function normaliseAddress(input: string): string {
  return input.replace(/\r\n?/g, '\n').trim();
}

export function BrandSettingsForm({ initial }: Props): React.ReactElement {
  const t = useTranslations('admin.settings.broadcasts.brand');
  const colourFieldId = useId();
  const pickerFieldId = useId();
  const addressFieldId = useId();
  const colourHintId = useId();
  const addressHintId = useId();

  const [view, setView] = useState<BrandSettingsView>(initial);
  const [colour, setColour] = useState(initial.primaryColor ?? '');
  const [address, setAddress] = useState(initial.postalAddress ?? '');
  const [serverContrast, setServerContrast] = useState<{ ratio: number; required: number } | null>(
    null,
  );
  const [isPending, startTransition] = useTransition();

  // An empty field means "use the platform default", which is the colour the
  // e-mail will actually carry — so that is the colour measured, not a blank.
  const typed = colour.trim();
  const effective = typed === '' ? view.defaults.primaryColor : typed;
  const parsed = useMemo(() => parseBrandPrimaryColor(effective), [effective]);
  const normalisedColour = parsed.ok ? parsed.value : null;
  const ratio = normalisedColour === null ? null : contrastRatioOnWhite(normalisedColour);
  const meetsAa = ratio !== null && ratio >= AA_MIN_CONTRAST;

  const normalisedAddress = normaliseAddress(address);
  const addressTooLong = normalisedAddress.length > BRAND_POSTAL_ADDRESS_MAX;
  const addressMissing = normalisedAddress.length === 0;

  const canSave = meetsAa && !addressTooLong && !isPending;

  function save(): void {
    startTransition(async () => {
      setServerContrast(null);
      try {
        const res = await fetch(BRAND_ENDPOINT, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            primaryColor: typed === '' ? null : normalisedColour,
            postalAddress: addressMissing ? null : normalisedAddress,
          }),
        });

        if (res.ok) {
          const next = (await res.json()) as BrandSettingsView;
          setView(next);
          setColour(next.primaryColor ?? '');
          setAddress(next.postalAddress ?? '');
          toast.success(t('toast.saved'));
          return;
        }

        if (res.status === 429) {
          const header = Number.parseInt(res.headers.get('Retry-After') ?? '', 10);
          const body = (await res.json().catch(() => ({}))) as ApiErrorBody;
          const seconds = Number.isFinite(header)
            ? header
            : (body.error?.details?.retryAfterSeconds ?? 60);
          toast.error(t('errors.rateLimited', { seconds }));
          return;
        }

        const body = (await res.json().catch(() => ({}))) as ApiErrorBody;
        if (res.status === 422 && body.error?.code === 'colour_contrast') {
          const measured = body.error.details?.ratio ?? ratio ?? 0;
          const required = body.error.details?.required ?? AA_MIN_CONTRAST;
          // The server measured it too; show ITS number, not ours — a mismatch
          // between the two is exactly what the reader needs to see.
          setServerContrast({ ratio: measured, required });
          toast.error(t('errors.colourContrast', { ratio: measured, required }));
          return;
        }
        if (res.status === 422) {
          toast.error(t('errors.validation'));
          return;
        }
        toast.error(t('errors.generic'));
      } catch (err) {
        console.error({ err }, 'broadcasts.brand.patch_failed');
        toast.error(t('errors.generic'));
      }
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('colour.heading')}</CardTitle>
          <CardDescription>{t('colour.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor={colourFieldId}>{t('colour.label')}</Label>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                id={colourFieldId}
                value={colour}
                onChange={(e) => setColour(e.target.value)}
                placeholder={view.defaults.primaryColor}
                spellCheck={false}
                autoComplete="off"
                inputMode="text"
                aria-describedby={colourHintId}
                aria-invalid={normalisedColour === null || !meetsAa}
                className="sm:max-w-40 font-mono"
              />
              {/* Keyboard-operable colour picker beside the text field — the
                  text field stays the source of truth so a screen-reader user
                  never depends on the swatch. */}
              <input
                id={pickerFieldId}
                type="color"
                aria-label={t('colour.pickerLabel')}
                value={normalisedColour ?? view.defaults.primaryColor}
                onChange={(e) => setColour(e.target.value)}
                className="h-9 w-14 shrink-0 cursor-pointer rounded-lg border border-input bg-transparent p-1 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              />
            </div>
            <p id={colourHintId} className="text-sm text-muted-foreground">
              {t('colour.hint')}
            </p>
            {typed === '' ? (
              <p className="text-sm text-muted-foreground">
                {t('colour.defaultHint', { color: view.defaults.primaryColor })}
              </p>
            ) : null}
          </div>

          {normalisedColour === null ? (
            <p className="text-sm text-destructive">{t('colour.invalid')}</p>
          ) : (
            <p
              data-testid="brand-contrast-readout"
              className={meetsAa ? 'text-sm text-success' : 'text-sm text-destructive'}
            >
              {meetsAa
                ? t('colour.contrastPass', { ratio: ratio! })
                : t('colour.contrastFail', { ratio: ratio!, required: AA_MIN_CONTRAST })}
            </p>
          )}
          {normalisedColour !== null && !meetsAa ? (
            <p className="text-sm text-muted-foreground">
              {t('colour.contrastFailHelp', { required: AA_MIN_CONTRAST })}
            </p>
          ) : null}
          {serverContrast !== null ? (
            <InlineAlert tone="destructive" data-testid="brand-contrast-server-error">
              <InlineAlertDescription>
                {t('errors.colourContrast', {
                  ratio: serverContrast.ratio,
                  required: serverContrast.required,
                })}
              </InlineAlertDescription>
            </InlineAlert>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('address.heading')}</CardTitle>
          <CardDescription>{t('address.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor={addressFieldId}>{t('address.label')}</Label>
          <Textarea
            id={addressFieldId}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={t('address.placeholder')}
            rows={4}
            aria-describedby={addressHintId}
            aria-invalid={addressTooLong}
          />
          <p
            id={addressHintId}
            data-testid="brand-address-counter"
            className={addressTooLong ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}
          >
            {t('address.counter', {
              count: normalisedAddress.length,
              max: BRAND_POSTAL_ADDRESS_MAX,
            })}
          </p>
          {addressTooLong ? (
            <p className="text-sm text-destructive">
              {t('address.tooLong', { max: BRAND_POSTAL_ADDRESS_MAX })}
            </p>
          ) : null}
          {addressMissing ? (
            // A state of the world, not an invalid entry: polite live region,
            // and Save stays available.
            <InlineAlert tone="warning" role="status" data-testid="brand-address-missing">
              <InfoIcon aria-hidden />
              <InlineAlertDescription>{t('address.missing')}</InlineAlertDescription>
            </InlineAlert>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('logo.heading')}</CardTitle>
          <CardDescription>{t('logo.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {view.logo.url === null ? (
            <p className="text-sm text-muted-foreground">{t('logo.none')}</p>
          ) : (
            /* The logo is a tenant-uploaded blob on an external host, and
               `next/image` would need every tenant's CDN in
               `images.remotePatterns` — same call as
               `directory-logo-control.tsx`. */
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={view.logo.url}
              alt={t('logo.alt')}
              className="max-h-16 w-auto rounded-md border bg-white p-2"
            />
          )}
          <p className="text-sm text-muted-foreground">{t('logo.source')}</p>
          {view.logo.manageHref === null ? (
            <p className="text-sm text-muted-foreground">{t('logo.askAdministrator')}</p>
          ) : (
            <Link
              href={view.logo.manageHref}
              className="text-sm font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring"
            >
              {t('logo.manage')}
            </Link>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button type="button" onClick={save} disabled={!canSave}>
          {isPending ? t('actions.saving') : t('actions.save')}
        </Button>
      </div>
    </div>
  );
}
