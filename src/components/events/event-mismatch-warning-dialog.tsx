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
 *   - `role="alertdialog"` inherited from shadcn `<AlertDialog>` (Radix).
 *   - Cancel = default focus + Escape key dismiss.
 *   - Continue button has `aria-describedby` linking the warning copy
 *     so screen readers announce the consequence before activation.
 *   - WCAG 2.5.8 target size: buttons inherit `min-h-11` from primitives.
 */
import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

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
  const describedById = useId();
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex flex-row items-center gap-2">
            <AlertTriangle
              aria-hidden="true"
              className="size-5 text-amber-600 dark:text-amber-500"
            />
            {t('title')}
          </AlertDialogTitle>
          <AlertDialogDescription id={describedById}>
            {t('description', { count: props.priorImports.length })}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {props.priorImports.length > 0 ? (
          <div className="rounded-md border bg-muted/40 p-3">
            <p className="text-caption mb-2 font-medium text-muted-foreground">
              {t('priorImportsHeading')}
            </p>
            <ul className="flex flex-col gap-2">
              {props.priorImports.map((p) => (
                <li
                  key={p.recordId}
                  className="text-body flex flex-col"
                >
                  <span className="font-medium">
                    {p.eventName ?? p.eventId}
                  </span>
                  <span className="text-caption text-muted-foreground">
                    {t('priorImportRow', {
                      uploadedAt: new Date(p.uploadedAt).toLocaleString(),
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-11">
            {t('cancelCta')}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={props.onContinue}
            aria-describedby={describedById}
            className="min-h-11"
          >
            {t('continueCta')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
