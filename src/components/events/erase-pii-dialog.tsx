/**
 * Erase attendee PII dialog (F6 Phase 10 T112 / FR-032a; spec 122 US9b-1
 * T922: on AURA `Dialog role="alertdialog"`, board `Admin-event-erase`).
 *
 * Admin-only destructive action for one attendee. Not offered when the row
 * is already pseudonymised (retention purge already removed the PII, and
 * re-erasure is an idempotent no-op that needs no UI surface).
 *
 * Behaviour (unchanged by the AURA swap):
 *   - the FR-032a body explains what erasure means: PII removed
 *     permanently, quota credited back, audit trail retained;
 *   - a required reason (1-500 chars) for DPO traceability. No typed
 *     phrase (spec 122 Clarifications, 2026-10-06 US9b start);
 *   - Confirm → POST /api/admin/events/{eventId}/registrations/{rid}/erase
 *     with { reasonText };
 *   - success → toast with the quota credit-back counts + router.refresh(),
 *     or `onErased` when the caller passes one (the deep-link erase page,
 *     whose registration no longer exists once erased);
 *   - 409 event_path_mismatch → error toast (likely race / stale UI);
 *   - 200 alreadyErased=true → info toast ("Already erased");
 *   - 403 → says a super admin is needed (both routes require
 *     `events.erasure`), not the generic "try again";
 *   - the dialog cannot close while the request is in flight, and an
 *     sr-only status line announces it.
 *
 * Opened two ways: its own "Erase PII" trigger (the erasure search page), or
 * controlled through `open` / `onOpenChange` from the attendee row's "More"
 * menu (T923), which passes `finalFocus` because the menu item is gone by
 * the time the dialog closes.
 */
'use client';

import { useRef, useState, useTransition, type RefObject } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Eraser } from 'lucide-react';
import { Button, Dialog, Textarea } from '@jirawatpyk/aura-react';
import { toast } from '@/lib/toast';

interface EraseResponse {
  readonly alreadyErased: boolean;
  readonly quotaReversals: {
    readonly partnership: number;
    readonly cultural: number;
  };
}

interface ErasePiiDialogProps {
  readonly eventId: string;
  readonly registrationId: string;
  /** Attendee name for context in the confirmation body. */
  readonly attendeeName: string;
  /** Controlled open state (the row menu); leave out to render the trigger. */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  /** Where focus goes on close when the opener no longer exists. */
  readonly finalFocus?: RefObject<HTMLElement | null>;
  /**
   * Where focus goes after a SUCCESSFUL erase: the row (and with it the
   * opener) is gone once the page refreshes (WCAG 2.4.3).
   */
  readonly successFocus?: () => HTMLElement | null;
  /**
   * Runs after a successful (or already-done) erase in place of
   * `router.refresh()`. The deep-link erase page sends the admin back to the
   * event: the erase deletes the registration, so a refresh would 404.
   */
  readonly onErased?: () => void;
  /** Open on arrival (uncontrolled only): the deep-link erase page. */
  readonly defaultOpen?: boolean;
}

const REASON_MAX = 500;

async function postErase(
  eventId: string,
  registrationId: string,
  reasonText: string,
): Promise<
  | { ok: true; data: EraseResponse }
  | { ok: false; status: number; title?: string; detail?: string }
> {
  const res = await fetch(
    `/api/admin/events/${eventId}/registrations/${registrationId}/erase`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reasonText }),
    },
  );
  if (res.ok) {
    const data = (await res.json()) as EraseResponse;
    return { ok: true, data };
  }
  let body: { title?: string; detail?: string } = {};
  try {
    body = (await res.json()) as { title?: string; detail?: string };
  } catch {
    // empty body
  }
  return { ok: false, status: res.status, ...body };
}

export function ErasePiiDialog({
  eventId,
  registrationId,
  attendeeName,
  open: controlledOpen,
  onOpenChange,
  finalFocus,
  successFocus,
  onErased,
  defaultOpen = false,
}: ErasePiiDialogProps) {
  const t = useTranslations('admin.events.detail.erase');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [ownOpen, setOwnOpen] = useState(defaultOpen);
  const [reasonText, setReasonText] = useState('');
  const succeeded = useRef(false);

  const controlled = controlledOpen !== undefined;
  const open = controlled ? controlledOpen : ownOpen;
  const setOpen = (next: boolean) => {
    if (!controlled) setOwnOpen(next);
    onOpenChange?.(next);
  };

  const reasonValid = reasonText.trim().length > 0 && reasonText.length <= REASON_MAX;

  function close() {
    // Never close while the POST is in flight (Cancel, Escape and the
    // scrim all come through here).
    if (pending) return;
    setOpen(false);
    setReasonText('');
  }

  function handleConfirm() {
    if (!reasonValid) return;
    startTransition(async () => {
      const result = await postErase(eventId, registrationId, reasonText.trim());
      succeeded.current = result.ok;
      setOpen(false);
      setReasonText('');
      if (result.ok) {
        if (result.data.alreadyErased) {
          toast.info(t('alreadyErasedTitle'), {
            description: t('alreadyErasedDescription'),
          });
        } else {
          toast.success(t('successTitle'), {
            description: t('successDescription', {
              partnership: result.data.quotaReversals.partnership,
              cultural: result.data.quotaReversals.cultural,
            }),
          });
        }
        if (onErased) onErased();
        else router.refresh();
      } else if (result.status === 409) {
        toast.error(t('pathMismatchTitle'), {
          description: t('pathMismatchDescription'),
        });
        router.refresh();
      } else if (result.status === 403) {
        toast.error(t('forbiddenTitle'), { description: t('forbiddenDescription') });
      } else {
        toast.error(t('errorTitle'), {
          description:
            (typeof result.title === 'string' && result.title) ||
            t('errorDescription'),
        });
      }
    });
  }

  const hintId = `erase-reason-hint-${registrationId}`;
  // Read at close: after a successful erase the opener's row is gone.
  const focusOnClose = () => {
    if (succeeded.current && successFocus) {
      succeeded.current = false;
      return successFocus();
    }
    return finalFocus?.current ?? null;
  };

  const trigger = controlled ? undefined : (
    <Button
      variant="danger-secondary"
      size="sm"
      touchHeight
      type="button"
      icon={<Eraser aria-hidden="true" />}
      loading={pending}
      aria-disabled={pending}
      aria-label={t('triggerAriaLabel', { attendeeName })}
      data-testid={`erase-pii-button-${registrationId}`}
    >
      {t('triggerCta')}
    </Button>
  );

  return (
    <Dialog
      role="alertdialog"
      open={open}
      onOpen={() => setOpen(true)}
      onClose={close}
      dismissible={!pending}
      {...(trigger ? { trigger } : {})}
      {...(finalFocus || successFocus ? { finalFocus: focusOnClose } : {})}
      title={t('confirmTitle', { attendeeName })}
      description={t('confirmBody', { attendeeName })}
      footer={
        <>
          <Button variant="secondary" data-autofocus disabled={pending} onClick={close}>
            {t('cancel')}
          </Button>
          {/* Reachable but refused until the reason is valid (AURA #102):
              aria-disabled + the hint as its description, not native disabled. */}
          <Button
            variant="danger"
            icon={<Eraser aria-hidden="true" />}
            loading={pending}
            aria-disabled={!reasonValid || undefined}
            aria-describedby={reasonValid ? undefined : hintId}
            onClick={handleConfirm}
          >
            {t('confirm')}
          </Button>
        </>
      }
    >
      {/* Mounted only while the dialog is open: one status line, not one per row. */}
      <span role="status" aria-live="polite" className="sr-only">
        {pending ? t('loading') : ''}
      </span>
      <Textarea
        id={`erase-reason-${registrationId}`}
        label={t('reasonLabel')}
        hint={<span id={hintId}>{t('reasonHint', { remaining: REASON_MAX - reasonText.length })}</span>}
        value={reasonText}
        onChange={(e) => setReasonText(e.target.value)}
        placeholder={t('reasonPlaceholder')}
        required
        maxLength={REASON_MAX}
        rows={4}
        disabled={pending}
      />
    </Dialog>
  );
}
