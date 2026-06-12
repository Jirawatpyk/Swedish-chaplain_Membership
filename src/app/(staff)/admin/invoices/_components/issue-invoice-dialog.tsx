'use client';

/**
 * F4 UX flow refactor — Issue invoice as AlertDialog.
 *
 * Replaces the previous `/admin/invoices/[id]/issue` full-page route
 * with an in-context AlertDialog triggered from the invoice detail
 * page. Aligns with the project's destructive-action pattern:
 *   - F3 `archive-member-button` (AlertDialog + reason textarea)
 *   - F2 `clone-year-dialog` (AlertDialog + typed confirmation)
 *   - F1 `idle-warning-dialog` (AlertDialog + decision)
 *
 * Why AlertDialog (not Dialog):
 *   - Issue is IRREVERSIBLE — §87 sequential number is permanently
 *     consumed; voiding requires a separate credit note.
 *   - AlertDialog forces explicit acknowledgement (Cancel + Continue
 *     are prominent, ESC/overlay click maps to Cancel).
 *
 * a11y:
 *   - `AlertDialogTitle` is the accessible name.
 *   - `AlertDialogDescription` includes the irreversible warning.
 *   - Pre-confirm summary is rendered inside the dialog body so SR
 *     users receive the numbers as part of the dialog content.
 *   - Typed-phrase input defers focus via `autoFocus={false}` (below)
 *     so the title/description are narrated first.
 */

import { useState, useTransition, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2Icon } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Props = {
  readonly invoiceId: string;
  /** Pre-confirm summary data — rendered inside the dialog body. */
  readonly summary: {
    readonly memberName: string;
    readonly planDisplayName: string;
    readonly planYear: number;
    readonly subtotalText: string;
    readonly vatText: string;
    readonly vatPercent: string;
    readonly totalText: string;
  };
};

export function IssueInvoiceDialog({ invoiceId, summary }: Props) {
  const t = useTranslations('admin.invoices.issue');
  const tDetail = useTranslations('admin.invoices.detail');
  const locale = useLocale();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [pending, startTransition] = useTransition();

  const confirmPhrase = t('confirmPhrase');
  const matches =
    typed.trim().toLocaleUpperCase(locale) ===
    confirmPhrase.toLocaleUpperCase(locale);

  // Reset transient state whenever dialog closes — prevents a stale
  // typed value from leaking into a later re-open (same pattern as
  // F3 archive-member-button R006).
  const handleOpenChange = useCallback((next: boolean) => {
    if (!next) setTyped('');
    setOpen(next);
  }, []);

  function confirm() {
    startTransition(async () => {
      const res = await fetch(`/api/invoices/${invoiceId}/issue`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const code = (body as { error?: { code?: string } })?.error?.code;
        toast.error(t('errors.failed'), {
          description:
            // 064 §105 ROOT FIX — human-readable copy for the no-TIN EVENT
            // guard, pointing the admin at the record-as-paid flow instead of
            // plain issue. (066 removed the membership tax_id_required gate — a
            // no-TIN membership now issues a valid §86/4 with name+address, so
            // there is no membership error code to surface here.)
            code === 'event_no_tin_requires_paid_issue'
              ? t('errors.event_no_tin_requires_paid_issue')
              // 064 S1 — registration refunded between draft and issue
              // (issuance-time TOCTOU re-check); human-readable copy so
              // the admin knows the draft is now a dead end, not retryable.
              : code === 'registration_refunded'
                ? t('errors.registration_refunded')
                : code
                  ? t('errors.codeFallback', { code })
                  : t('errors.unknown'),
        });
        return;
      }
      toast.success(t('success'));
      setOpen(false);
      setTyped('');
      router.refresh();
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger className={buttonVariants({ variant: 'default' })}>
        {tDetail('actions.issue')}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('irreversibleWarning')}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* Pre-confirm summary — inside dialog body so SR narrates
            these numbers as part of the dialog content (not after
            closing). */}
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">{tDetail('fields.memberId')}</dt>
            <dd className="font-medium">{summary.memberName}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{tDetail('fields.plan')}</dt>
            <dd className="font-medium">
              {summary.planDisplayName}
              <span className="ml-1 text-xs text-muted-foreground">
                / {summary.planYear}
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{tDetail('fields.subtotal')}</dt>
            <dd className="tabular-nums">{summary.subtotalText} THB</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">
              {tDetail('fields.vat')}
              {summary.vatPercent && (
                <span className="ml-1 text-xs">({summary.vatPercent})</span>
              )}
            </dt>
            <dd className="tabular-nums">{summary.vatText} THB</dd>
          </div>
          <div className="col-span-2 border-t pt-2">
            <dt className="text-muted-foreground">{tDetail('fields.total')}</dt>
            <dd className="text-lg font-semibold tabular-nums">
              {summary.totalText} THB
            </dd>
          </div>
        </dl>

        <div className="grid gap-2">
          <Label htmlFor="issue-confirm">
            {t('confirmCopy', { phrase: confirmPhrase })}
          </Label>
          <Input
            id="issue-confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={confirmPhrase}
            autoComplete="off"
            // R7-S9 — prevent iOS from auto-correcting the typed
            // phrase (would silently mangle the exact-match check)
            // and give Android a "Done" keyboard action on commit.
            inputMode="text"
            enterKeyHint="done"
            autoCorrect="off"
            autoCapitalize="characters"
            spellCheck={false}
            aria-invalid={typed.length > 0 && !matches}
            aria-describedby={
              typed.length > 0 && !matches ? 'issue-confirm-error' : undefined
            }
          />
          {typed.length > 0 && !matches && (
            <p
              id="issue-confirm-error"
              role="alert"
              className="text-xs text-destructive"
            >
              {t('confirmMismatch', { phrase: confirmPhrase })}
            </p>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>
            {t('cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              confirm();
            }}
            disabled={!matches || pending}
            aria-busy={pending}
          >
            {pending && (
              <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" />
            )}
            {pending ? t('issuing') : t('issueButton')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
