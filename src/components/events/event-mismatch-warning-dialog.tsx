'use client';

/**
 * T027 (Feature 013 · F6.1) — Event-mismatch warning AlertDialog.
 *
 * Renders when the FR-019b safety net detects that the upload's
 * attendee fingerprint matches a prior import (within 30 days, same
 * tenant, DIFFERENT event). Shows the list of prior imports so the
 * admin can confirm whether they meant to upload to a different event,
 * then either Cancel (default focus — safest action) or "Continue
 * anyway" which re-submits the parent form with `force_proceed=true`.
 *
 * Accessibility:
 *   - AURA `Dialog role="alertdialog"` (spec 122 US9b-2).
 *   - Cancel = first in the footer, so it takes the initial focus; Escape
 *     dismisses.
 *   - Continue button has `aria-describedby` linking the warning copy
 *     so screen readers announce the consequence before activation.
 *   - WCAG 2.5.8 target size: buttons inherit `min-h-11` from primitives.
 */
import { useId } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Button, Dialog, Icon } from '@jirawatpyk/aura-react';
import { formatDatePreset } from '@/lib/format-date-localised';

export interface PriorImportEntry {
  readonly recordId: string;
  readonly eventId: string;
  readonly uploadedAt: string;
  /**
   * Event name + date for the prior import. Optional because the route
   * response from `event_mismatch_warning` only includes ids; the
   * parent component enriches via the events list cache. When absent,
   * the dialog falls back to `eventId` as a humane label.
   */
  readonly eventName?: string;
  readonly eventStartDate?: string;
}

export interface EventMismatchWarningDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly priorImports: ReadonlyArray<PriorImportEntry>;
  /** Fires when admin clicks "Continue anyway" — parent re-submits with force_proceed=true. */
  readonly onContinue: () => void;
}

export function EventMismatchWarningDialog(
  props: EventMismatchWarningDialogProps,
): React.JSX.Element {
  const t = useTranslations('admin.events.import.eventMismatch');
  // UX-C-2 (Round 1) — locale-aware date/time via next-intl, not
  // `Date.prototype.toLocaleString()` which uses browser locale.
  const locale = useLocale();
  const describedById = useId();
  const close = () => props.onOpenChange(false);
  return (
    <Dialog
      open={props.open}
      onClose={close}
      role="alertdialog"
      aria-describedby={describedById}
      title={
        <span className="flex flex-row items-center gap-[var(--aura-space-2)]">
          <Icon
            name="triangle-alert"
            size="md"
            className="shrink-0 text-[var(--aura-fg-warning)]"
          />
          {t('title')}
        </span>
      }
      footer={
        <>
          <Button type="button" variant="secondary" touchHeight onClick={close}>
            {t('cancelCta')}
          </Button>
          <Button
            type="button"
            touchHeight
            aria-describedby={describedById}
            onClick={() => {
              close();
              props.onContinue();
            }}
          >
            {t('continueCta')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-[var(--aura-space-3)]">
        <p id={describedById}>
          {t('description', { count: props.priorImports.length })}
        </p>
        {props.priorImports.length > 0 ? (
          <div className="rounded-[var(--aura-radius-md)] border border-[var(--aura-border-subtle)] bg-[var(--aura-bg-canvas)] p-[var(--aura-space-3)]">
            <p className="aura-text-caption mb-[var(--aura-space-2)] font-medium text-[var(--aura-fg-secondary)]">
              {t('priorImportsHeading')}
            </p>
            <ul className="flex flex-col gap-[var(--aura-space-2)]">
              {props.priorImports.map((p) => (
                <li key={p.recordId} className="flex flex-col">
                  <span className="font-medium">
                    {p.eventName ?? p.eventId}
                  </span>
                  <span className="aura-text-caption text-[var(--aura-fg-secondary)]">
                    {t('priorImportRow', {
                      uploadedAt: formatDatePreset(p.uploadedAt, locale, 'mediumWithTime'),
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
