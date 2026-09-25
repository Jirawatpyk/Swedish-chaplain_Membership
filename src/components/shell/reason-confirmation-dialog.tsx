'use client';

/**
 * Shared reason-confirmation dialog (DV-12 review follow-up #11).
 *
 * Extracted from the near-identical reject-dialog.tsx + cancel-broadcast-dialog.tsx
 * pair (they shared ~180 lines: the double-RAF focus effect, the finalFocus
 * chain, the Label+Textarea+counter+over-cap block, the destructive footer, the
 * validation + pending plumbing). This component owns all of that shared UI +
 * state; each caller (reject / cancel) stays a thin wrapper that owns ONLY its
 * own fetch + toast + close + refresh via the `onConfirm` callback.
 *
 * Design seam (see DV-12 understand-phase reject behavior contract):
 *   - `onConfirm(reason)` is called inside this component's `useTransition`, so
 *     the caller does NOT manage `pending`; while the caller's promise is in
 *     flight the fields are read-only, Cancel is disabled, Confirm is busy
 *     (focusable, spinning) and Escape / backdrop cannot close the dialog.
 *   - The RAW (untrimmed) reason is passed to `onConfirm` so callers preserve
 *     their verbatim-reason wire contract (reject sends the reason verbatim).
 *   - Response parsing / status→toast mapping stays in each caller (reject reads
 *     no body and maps any 409 → concurrentRace; cancel reads body.error.code
 *     and splits too-late vs concurrent vs generic). Do NOT lift fetch here.
 *   - Focus rule: `reasonRequired ? auto-focus the textarea (double-RAF) :
 *     initial-focus the Cancel button (Base UI initialFocus)`. This reproduces
 *     reject (always required → textarea) and cancel (admin → textarea, member →
 *     Cancel button) exactly.
 *   - Reason is reset on OPEN (not on close) so a re-open is always fresh
 *     regardless of how the previous interaction closed — this is the robust
 *     fix for the "stale reason on programmatic close" review finding (#1):
 *     success/409 close paths call the caller's `onOpenChange(false)` directly
 *     (Base UI does not fire onOpenChange for a controlled programmatic close),
 *     so resetting on close would miss them; resetting on open covers every path.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from 'react';
import { useTranslations } from 'next-intl';
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
} from '@/components/ui/alert-dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  TypedPhraseField,
  normalizeTypedPhrase,
  typedPhraseMatches,
} from '@/components/shell/typed-phrase-field';
import { resolveDialogFinalFocus } from '@/components/broadcast/resolve-dialog-final-focus';
import { InlineError } from '@/components/broadcast/approval/inline-error';
import { InlineWarning } from '@/components/broadcast/approval/inline-warning';

/** What the typed-phrase gate asks for, resolved from the caller's text. */
interface PhraseGate {
  readonly expected: string;
  readonly label: string;
  readonly error: string;
  /** Null on the fixed-word fallback — "Copy subject" would be untrue there. */
  readonly copy: { readonly label: string; readonly copiedMessage: string } | null;
}

/**
 * F7-A11Y-1 — shared focus-return chain for the broadcast confirmation dialogs.
 *
 * Returns a `finalFocus` callback Base UI calls on close. The trigger button
 * lives outside the dialog and UNMOUNTS after the programmatic close paths
 * (success / 409 / — for cancel — 404/403), each of which runs
 * `router.refresh()` and flips the row out of its actionable status. At the
 * instant Base UI reads finalFocus the trigger is STILL mounted, so returning
 * it would drop focus to <body> milliseconds later.
 *
 * Pass `closedViaSuccessRef` (raised by the caller on those programmatic
 * closes): when set, the resolver SKIPS the about-to-unmount trigger and lands
 * on the surviving fallbackFocusRef → #main-content landmark (focusable via
 * tabIndex=-1). On Cancel / ESC the flag stays false, so the trigger is
 * returned. WCAG 2.1 AA SC 2.4.3. See {@link resolveDialogFinalFocus}.
 *
 * Each caller invokes this hook and passes the result as `finalFocus={…}` so the
 * wiring stays visible at the call site (keeps approve-reject-final-focus.test
 * source assertions valid).
 */
export function useDialogFinalFocus(
  triggerRef?: React.RefObject<HTMLButtonElement | null>,
  fallbackFocusRef?: React.RefObject<HTMLElement | null>,
  closedViaSuccessRef?: React.RefObject<boolean>,
): () => HTMLElement | false | null {
  return useCallback((): HTMLElement | false | null => {
    const mainContent =
      typeof document !== 'undefined'
        ? document.getElementById('main-content')
        : null;
    const target = resolveDialogFinalFocus({
      closedViaSuccess: closedViaSuccessRef?.current ?? false,
      trigger: triggerRef?.current ?? null,
      fallback: fallbackFocusRef?.current ?? null,
      mainContent,
    });
    if (target !== null && target === mainContent) {
      // 2026-09-10 (e2e `@bulk` focus case) — Base UI does NOT focus the element
      // we return. `FloatingFocusManager` applies `returnFocus` as
      // `getFirstTabbableElement(el)`: "the element, if tabbable, or its FIRST
      // TABBABLE CHILD". The landmark is `tabIndex={-1}` — focusable, not
      // tabbable — so every success close on every dialog using this hook
      // landed on the first link inside <main> (traced: the review queue's
      // "Templates" header link), not on the landmark F7-A11Y-1 named.
      //
      // So focus it ourselves and answer `false` ("move nothing"). Base UI
      // calls this getter synchronously in its cleanup and queues ITS focus
      // in one microtask afterwards; our outer microtask is queued first, so
      // the inner one runs after theirs — deterministic without a timer.
      queueMicrotask(() => {
        queueMicrotask(() => {
          if (mainContent.isConnected) mainContent.focus({ preventScroll: true });
        });
      });
      return false;
    }
    return target;
  }, [triggerRef, fallbackFocusRef, closedViaSuccessRef]);
}

export interface ReasonConfirmationDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
  /** next-intl namespace for the dialog strings (title, description, reason fields, confirm, cancel, errors.reasonTooLong). */
  readonly namespace: string;
  /** Max reason length (reject = 2000, cancel = 500). */
  readonly maxLength: number;
  /**
   * true  → reason required (1..maxLength); textarea auto-focuses on open.
   * false → reason optional (≤maxLength); the Cancel button receives initial focus.
   */
  readonly reasonRequired: boolean;
  /** Unique id prefix for the textarea + its aria-describedby targets (e.g. 'reject-reason'). */
  readonly fieldIdPrefix: string;
  /** Textarea rows (reject = 5, cancel = 4). */
  readonly textareaRows: number;
  /**
   * Caller-owned submission. Receives the RAW (untrimmed) reason. Runs inside
   * this component's useTransition; the caller does fetch + toast + close +
   * refresh and may throw (kept open for retry). Errors are swallowed here so
   * `pending` always resets — the caller is responsible for surfacing them.
   */
  readonly onConfirm: (reason: string) => Promise<void>;
  /** Focus-return target on close — build via {@link useDialogFinalFocus}. */
  /** `false` = "Base UI moves nothing" — the hook focuses the landmark itself. */
  readonly finalFocus: () => HTMLElement | false | null;
  /**
   * ux-standards § 6.3 — for an IRREVERSIBLE action, the text the person must
   * type before Confirm enables (the shared {@link TypedPhraseField}, same
   * matching rule as clear-halt). F119 U35: the E-Blast cancel passes the
   * SUBJECT, read from `namespace` as `subjectLabel` / `subjectError` /
   * `copySubject` / `subjectCopied`, with `phraseHelp` under the input.
   *
   * A value that normalises to EMPTY (punctuation only) falls back to the
   * fixed per-locale `phrase` (`phraseLabel` with `{phrase}`, `phraseError`):
   * an empty expected text would let an empty — or any punctuation-only —
   * input through.
   *
   * Undefined (the default) = no gate: reject / approve / the F114 decision
   * dialog are not irreversible and stay one step.
   */
  readonly typedPhrase?: string;
  /**
   * F119 T067 (FR-010) — with a REQUIRED reason, a reason field left blank
   * (on blur) is an announced field error: `aria-invalid`, described by the
   * error, `role="alert"` (ux-standards § 4.1), read from
   * `namespace.errors.reasonRequired`. Confirm stays disabled either way; this
   * is what tells a screen-reader user WHY. Off by default, so the existing
   * callers keep their behaviour.
   */
  readonly announceBlankReason?: boolean;
  /**
   * F119 T084 — a server refusal said INSIDE the open dialog (ux-standards
   * § 6.4: inline, `role="alert"`, focused — a toast renders outside the
   * modal, which hides everything outside itself from AT). `field: 'reason'`
   * marks the reason field invalid, describes it and focuses it; `null` is a
   * form-level line above the buttons, focused itself.
   *
   * `seq` — the caller bumps it on every refusal. `onConfirm` runs inside this
   * component's transition, so a caller's "clear at the start" never commits
   * before the next refusal lands; the error node is keyed on `seq`, so an
   * identical refusal repeated is a NEW node and is announced again.
   *
   * `tone: 'warning'` (PR #392 review D4) — a form-level refusal that is
   * nobody's error (the read-only write freeze): `message` is the title and
   * `description` the line under it, in the warning tone. Default: the red
   * `InlineError`, as before.
   */
  readonly refusal?: {
    readonly message: string;
    readonly field: 'reason' | null;
    readonly seq?: number;
    readonly tone?: 'warning' | undefined;
    readonly description?: string | undefined;
  } | null;
  /**
   * ux-standards § 6.2 — the Confirm tier. `destructive` (the default: red)
   * for an irreversible or destructive action; `primary` for a normal,
   * reversible step (F119 "Request changes").
   */
  readonly confirmTone?: 'destructive' | 'primary';
}

export function ReasonConfirmationDialog({
  open,
  onOpenChange,
  namespace,
  maxLength,
  reasonRequired,
  fieldIdPrefix,
  textareaRows,
  onConfirm,
  finalFocus,
  typedPhrase,
  announceBlankReason = false,
  refusal = null,
  confirmTone = 'destructive',
}: ReasonConfirmationDialogProps): React.ReactElement {
  const t = useTranslations(namespace);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [reason, setReason] = useState('');
  const [phraseInput, setPhraseInput] = useState('');
  const [reasonBlurred, setReasonBlurred] = useState(false);
  const [pending, startTransition] = useTransition();

  // Reset on OPEN so every re-open starts fresh — covers the programmatic close
  // paths (success / 409) that call onOpenChange(false) directly and bypass Base
  // UI's onOpenChange, which a reset-on-close would miss (stale-reason fix #1).
  // Uses the render-time "adjust state when a prop changes" pattern (not an
  // effect) to avoid the react-hooks/set-state-in-effect cascade rule.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setReason('');
      setPhraseInput('');
      setReasonBlurred(false);
    }
  }

  // Required-reason dialogs auto-focus the textarea via chained double-RAF
  // (mirrors the original reject/cancel Review UX I4 pattern — no fixed timeout
  // that races on slow devices / reduced-motion). Optional-reason dialogs
  // instead hand initial focus to the Cancel button via Base UI `initialFocus`.
  useEffect(() => {
    if (!open || !reasonRequired) return undefined;
    let raf2 = 0;
    const raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    });
    return () => {
      window.cancelAnimationFrame(raf1);
      if (raf2 !== 0) window.cancelAnimationFrame(raf2);
    };
  }, [open, reasonRequired]);

  const overCap = reason.length > maxLength;
  const reasonValid = reasonRequired
    ? reason.trim().length >= 1 && !overCap
    : !overCap;
  // Only read when the gate is on — callers without it ship no phrase keys.
  // An expected text that normalises to empty falls back to the fixed word,
  // or an empty input would pass (see the `typedPhrase` prop).
  const gate: PhraseGate | null =
    typedPhrase === undefined
      ? null
      : normalizeTypedPhrase(typedPhrase) === ''
        ? {
            expected: t('phrase'),
            label: t('phraseLabel', { phrase: t('phrase') }),
            error: t('phraseError'),
            copy: null,
          }
        : {
            expected: typedPhrase,
            label: t('subjectLabel'),
            error: t('subjectError'),
            copy: { label: t('copySubject'), copiedMessage: t('subjectCopied') },
          };
  const phraseValid = gate === null || typedPhraseMatches(phraseInput, gate.expected);
  const valid = reasonValid && phraseValid;

  function handleConfirm(): void {
    if (!valid || pending) return;
    startTransition(async () => {
      // Caller owns fetch/toast/close/refresh and may throw to keep the dialog
      // open for retry; swallow here so `pending` always settles.
      try {
        await onConfirm(reason);
      } catch {
        /* caller already surfaced the error toast */
      }
    });
  }

  const helpId = `${fieldIdPrefix}-help`;
  const counterId = `${fieldIdPrefix}-counter`;
  const fieldErrorId = `${fieldIdPrefix}-error`;
  const tooLongId = `${fieldIdPrefix}-too-long`;
  const formErrorId = `${fieldIdPrefix}-form-error`;
  // The field's own error: a required reason left blank (opt-in), else a
  // server refusal naming the reason field. Over-cap keeps its own line.
  const blankReason = announceBlankReason && reasonRequired && reasonBlurred && reason.trim().length === 0;
  const fieldError = blankReason
    ? t('errors.reasonRequired')
    : refusal !== null && refusal.field === 'reason'
      ? refusal.message
      : null;
  const formError = refusal !== null && refusal.field === null ? refusal.message : null;
  // M1 — a refusal's node is keyed on its `seq`, so a repeat is a new node.
  const refusalKey = `refusal-${refusal?.seq ?? 0}`;
  const describedBy = [
    fieldError !== null ? fieldErrorId : null,
    overCap ? tooLongId : null,
    helpId,
    counterId,
  ]
    .filter((id) => id !== null)
    .join(' ');

  // ux-standards § 6.4 — a refusal is surfaced inline AND focused: the reason
  // field when the refusal names it, else the form-level line (focusable via
  // its `tabIndex={-1}`). Keyed on the refusal itself, never on `fieldError`:
  // the blank-on-blur check must not pull focus back into the field.
  useEffect(() => {
    if (refusal === null) return;
    if (refusal.field === 'reason') textareaRef.current?.focus();
    else document.getElementById(formErrorId)?.focus();
  }, [refusal, formErrorId]);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // L5 — Escape / backdrop cannot close the dialog while the request
        // runs: the result would land on a closed dialog. Callers' own
        // programmatic closes call their `onOpenChange` directly, not this.
        if (!next && pending) return;
        onOpenChange(next);
      }}
    >
      <AlertDialogContent
        className="max-w-lg"
        finalFocus={finalFocus}
        {...(reasonRequired ? {} : { initialFocus: cancelRef })}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{t('title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('description')}</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-2">
          <Label htmlFor={fieldIdPrefix}>{t('reasonLabel')}</Label>
          {/* H2 — read-only (never `disabled`) while the request runs: a
              disabled control that holds focus drops it to <body>. */}
          <Textarea
            id={fieldIdPrefix}
            ref={textareaRef}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onBlur={(e) => {
              // L3 — heading for Cancel is leaving, not a blank answer.
              if (e.relatedTarget !== null && e.relatedTarget === cancelRef.current) return;
              setReasonBlurred(true);
            }}
            placeholder={t('reasonPlaceholder')}
            rows={textareaRows}
            readOnly={pending}
            aria-describedby={describedBy}
            aria-invalid={overCap || fieldError !== null}
          />
          {/* L4 — every error sits immediately under the field it describes. */}
          {fieldError !== null ? (
            <InlineError key={blankReason ? 'blank' : refusalKey} id={fieldErrorId} message={fieldError} />
          ) : null}
          {overCap ? <InlineError id={tooLongId} message={t('errors.reasonTooLong')} /> : null}
          <p id={helpId} className="text-xs text-muted-foreground">
            {t('reasonHelp')}
          </p>
          <p
            id={counterId}
            aria-live="polite"
            className={cn(
              'text-xs',
              overCap ? 'font-semibold text-destructive' : 'text-muted-foreground',
            )}
          >
            {reason.length} / {maxLength}
          </p>
        </div>

        {gate !== null ? (
          <TypedPhraseField
            id={`${fieldIdPrefix}-phrase`}
            label={gate.label}
            phrase={gate.expected}
            value={phraseInput}
            onChange={setPhraseInput}
            errorMessage={gate.error}
            helpText={t('phraseHelp')}
            {...(gate.copy !== null ? { copy: gate.copy } : {})}
            onSubmit={handleConfirm}
            readOnly={pending}
          />
        ) : null}

        {formError === null ? null : refusal?.tone === 'warning' ? (
          <InlineWarning key={refusalKey} id={formErrorId} title={formError} description={refusal.description} />
        ) : (
          <InlineError key={refusalKey} id={formErrorId} message={formError} />
        )}

        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelRef} disabled={pending}>
            {t('cancel')}
          </AlertDialogCancel>
          {/* ux-standards § 6.2 — red for a destructive action, primary for a
              reversible one (`confirmTone`). While the request runs Confirm
              stays focusable (`focusableWhenDisabled`), says it is busy and
              spins; idle and invalid it is natively disabled.
              preventDefault stops AlertDialogAction's default auto-close so the
              dialog only closes via the caller's onOpenChange after the fetch
              settles (stays open on a transient error for retry). */}
          <AlertDialogAction
            disabled={!valid || pending}
            focusableWhenDisabled={pending}
            aria-busy={pending || undefined}
            className={cn(
              confirmTone === 'destructive' && [
                'bg-destructive text-destructive-foreground',
                'hover:bg-destructive/90',
                'focus-visible:ring-destructive',
              ],
            )}
            onClick={(e) => {
              e.preventDefault();
              handleConfirm();
            }}
          >
            {pending ? <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : null}
            {t('confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
