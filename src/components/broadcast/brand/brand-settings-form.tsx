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
 *     refusal is never a surprise. The arithmetic is the Domain's own,
 *     reached through `@/lib/brand-settings-client` — a second copy would
 *     drift from what the server refuses with. Save is gated on the SAME
 *     predicate the server refuses with (`meetsAaOnWhiteText`, raw ratio),
 *     never on the displayed ratio (`contrastRatioOnWhite`, two decimals).
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
 *
 * T155 § 15 findings closed here:
 *   - **U19** the screen is a real `<form>`, so Enter in the colour field
 *     saves. (The address textarea keeps Enter for a newline — FR-041c makes
 *     the address multi-line, and that is a textarea's native behaviour
 *     inside a form.) The two compose surfaces stay `<div>` roots on purpose:
 *     a rich-text body owns Enter.
 *   - **U17** a disabled Save names its reason through `aria-describedby`; a
 *     keyboard user used to hear "Save, dimmed" and nothing else (WCAG 3.3.2).
 *   - **U18** an unsaved colour or address arms the browser's leave prompt,
 *     as both compose surfaces already did.
 *   - **U16** the logo swatch is a themed surface with a transparency
 *     checker, not `bg-white`. See its comment for why the e-mail PREVIEW
 *     iframe keeps white and this does not.
 */
import Link from 'next/link';
import { useId, useMemo, useState, useTransition } from 'react';
import { UnsavedChangesGuard } from '@/components/shell/unsaved-changes-guard';
import { useTranslations } from 'next-intl';
import { Alert, Button, Card, TextField, Textarea } from '@jirawatpyk/aura-react';
import { FIELD_BOX_OFFSET } from '@/components/shell/field-box-offset';
import { toast } from '@/lib/toast';
import { TRANSPARENCY_CHECKER_STYLE } from '@/components/shell/transparency-checker';
import {
  AA_MIN_CONTRAST,
  BRAND_POSTAL_ADDRESS_MAX,
  contrastRatioOnWhite,
  meetsAaOnWhiteText,
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
  // U17 — the two reasons Save can be disabled, each on the element that
  // already states it visibly.
  const colourReasonId = useId();
  const addressTooLongId = useId();

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
  const meetsAa = normalisedColour !== null && meetsAaOnWhiteText(normalisedColour);

  const normalisedAddress = normaliseAddress(address);
  const addressTooLong = normalisedAddress.length > BRAND_POSTAL_ADDRESS_MAX;
  const addressMissing = normalisedAddress.length === 0;

  const canSave = meetsAa && !addressTooLong && !isPending;

  // U17 — every reason the Save is dimmed, in DOM order, so a screen reader
  // hears them all. Empty when Save is enabled: an `aria-describedby` that
  // always points somewhere would describe a control that has nothing wrong.
  const saveBlockedReasonIds = [
    ...(meetsAa ? [] : [colourReasonId]),
    ...(addressTooLong ? [addressTooLongId] : []),
  ].join(' ');

  // U18 — the last SAVED view is `view`; `save()` replaces it on 200, so a
  // successful save disarms this without a second snapshot to keep in step.
  // U27 (portal live walk) — the same flag now arms BOTH exits: the browser's
  // unload prompt and an in-app `<Link>`, including the "Manage logo" link
  // inside this very form.
  const unsavedChanges =
    !isPending &&
    (colour !== (view.primaryColor ?? '') ||
      address !== (view.postalAddress ?? ''));

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
    <form
      className="flex flex-col gap-[var(--aura-space-6)]"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) save();
      }}
    >
      <UnsavedChangesGuard armed={unsavedChanges} />
      <Card title={t('colour.heading')} description={t('colour.description')} headingLevel={2}>
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-2">
            <TextField
              id={colourFieldId}
              className="min-w-0 flex-1 sm:max-w-40 sm:flex-none"
              label={t('colour.label')}
              value={colour}
              onChange={(e) => setColour(e.target.value)}
              placeholder={view.defaults.primaryColor}
              spellCheck={false}
              autoComplete="off"
              inputMode="text"
              aria-describedby={colourHintId}
              aria-invalid={normalisedColour === null || !meetsAa}
              touchHeight
            />
            {/* Keyboard-operable colour picker beside the text field — the
                text field stays the source of truth so a screen-reader user
                never depends on the swatch. It drops by the field label's
                line to sit level with the input, beside it at every width
                (UX M5). */}
            <input
              id={pickerFieldId}
              type="color"
              aria-label={t('colour.pickerLabel')}
              value={normalisedColour ?? view.defaults.primaryColor}
              onChange={(e) => setColour(e.target.value)}
              className={`h-11 w-14 shrink-0 cursor-pointer rounded-[var(--aura-radius-md)] border border-[var(--aura-border-control)] bg-transparent p-1 sm:h-9 ${FIELD_BOX_OFFSET}`}
            />
          </div>
          <p id={colourHintId} className="aura-text-caption text-[var(--aura-fg-secondary)]">
            {t('colour.hint')}
          </p>
          {typed === '' ? (
            <p className="aura-text-caption text-[var(--aura-fg-secondary)]">
              {t('colour.defaultHint', { color: view.defaults.primaryColor })}
            </p>
          ) : null}

          {/* U17 — exactly ONE of these two renders, so they share the id the
              Save button points at when the colour is what blocks it. */}
          {normalisedColour === null ? (
            <p id={colourReasonId} className="aura-text-body text-[var(--aura-fg-danger)]">
              {t('colour.invalid')}
            </p>
          ) : (
            <p
              id={colourReasonId}
              data-testid="brand-contrast-readout"
              className={
                meetsAa
                  ? 'aura-text-body text-[var(--aura-fg-positive)]'
                  : 'aura-text-body text-[var(--aura-fg-danger)]'
              }
            >
              {meetsAa
                ? t('colour.contrastPass', { ratio: ratio! })
                : t('colour.contrastFail', { ratio: ratio!, required: AA_MIN_CONTRAST })}
            </p>
          )}
          {normalisedColour !== null && !meetsAa ? (
            <p className="aura-text-caption text-[var(--aura-fg-secondary)]">
              {t('colour.contrastFailHelp', { required: AA_MIN_CONTRAST })}
            </p>
          ) : null}
          {serverContrast !== null ? (
            <Alert tone="danger" data-testid="brand-contrast-server-error">
              {t('errors.colourContrast', {
                ratio: serverContrast.ratio,
                required: serverContrast.required,
              })}
            </Alert>
          ) : null}
        </div>
      </Card>

      <Card title={t('address.heading')} description={t('address.description')} headingLevel={2}>
        <div className="flex flex-col gap-2">
          <Textarea
            id={addressFieldId}
            label={t('address.label')}
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
            className={
              addressTooLong
                ? 'aura-text-caption text-[var(--aura-fg-danger)]'
                : 'aura-text-caption text-[var(--aura-fg-secondary)]'
            }
          >
            {t('address.counter', {
              count: normalisedAddress.length,
              max: BRAND_POSTAL_ADDRESS_MAX,
            })}
          </p>
          {addressTooLong ? (
            <p id={addressTooLongId} className="aura-text-caption text-[var(--aura-fg-danger)]">
              {t('address.tooLong', { max: BRAND_POSTAL_ADDRESS_MAX })}
            </p>
          ) : null}
          {addressMissing ? (
            // A state of the world, not an invalid entry: polite live region,
            // and Save stays available.
            <Alert tone="warning" role="status" data-testid="brand-address-missing">
              {t('address.missing')}
            </Alert>
          ) : null}
        </div>
      </Card>

      <Card title={t('logo.heading')} description={t('logo.description')} headingLevel={2}>
        <div className="flex flex-wrap items-center gap-[var(--aura-space-4)]">
          {view.logo.url === null ? (
            <p className="aura-text-body text-[var(--aura-fg-secondary)]">{t('logo.none')}</p>
          ) : (
            /* The logo is a tenant-uploaded blob on an external host, and
               `next/image` would need every tenant's CDN in
               `images.remotePatterns` — same call as
               `directory-logo-control.tsx`.

               T155 finding U16, revised by the F119 UX review — the backing
               is the fixed LIGHT checker: the logo shown the way the E-Blast
               shows it, on white (every mail client composites the email on
               white), with the check marking transparent pixels. A themed
               checker hid dark logos in dark mode. */
            <div
              data-testid="brand-logo-preview"
              className="inline-block rounded-[var(--aura-radius-md)] border border-[var(--aura-border-default)] p-2"
              style={TRANSPARENCY_CHECKER_STYLE}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={view.logo.url}
                alt={t('logo.alt')}
                className="max-h-16 w-auto"
              />
            </div>
          )}
          <div className="flex flex-col gap-1">
            <p className="aura-text-caption text-[var(--aura-fg-secondary)]">{t('logo.source')}</p>
            {view.logo.manageHref === null ? (
              <p className="aura-text-caption text-[var(--aura-fg-secondary)]">{t('logo.askAdministrator')}</p>
            ) : (
              <Link
                href={view.logo.manageHref}
                className="aura-text-body font-medium text-[var(--aura-fg-accent)] underline-offset-4 hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center"
              >
                {t('logo.manage')}
              </Link>
            )}
          </div>
        </div>
      </Card>

      <div className="flex justify-end">
        <Button
          type="submit"
          variant="primary"
          touchHeight
          className="max-sm:w-full"
          disabled={!canSave}
          {...(saveBlockedReasonIds !== ''
            ? { 'aria-describedby': saveBlockedReasonIds }
            : {})}
        >
          {isPending ? t('actions.saving') : t('actions.save')}
        </Button>
      </div>
    </form>
  );
}
