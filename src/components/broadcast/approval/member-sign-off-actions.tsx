'use client';

/**
 * F119 T084 (US2, FR-009, FR-010, FR-015, FR-015a) — the member's decision on
 * the version the chamber sent them, on `/portal/broadcasts/[id]`.
 *
 * `POST /api/broadcasts/[id]/decision` carries all three member decisions
 * (contracts/portal-eblast-approval-api.md § decision); the server PAGE
 * decides which of them exist for the stage it rendered (`canDecide`,
 * `canWithdrawApproval`, `canWithdrawEblast`) and this island only performs
 * them:
 *
 *   - Approve — an optional note (≤ 500), confirmed in a dialog that states
 *     that marketing now confirms the send time and that the content cannot
 *     change without a new approval (FR-009). Not destructive: primary tier.
 *   - Request changes — a required reason (1–2,000) in the shared
 *     `ReasonConfirmationDialog` (FR-010); a reason left blank is an
 *     announced field error. A normal, reversible step, not a destructive
 *     one: an outline trigger and a primary Confirm (UX review M2).
 *   - Withdraw approval — the same dialog, reason required (FR-015a),
 *     destructive tier.
 *   - Withdraw E-Blast — the EXISTING member cancel (`CancelBroadcastAction`,
 *     typed subject, #376), reused as is rather than duplicated.
 *
 * Every decision names the latest version SENT to the member (`version`) —
 * the one the route compares against for `stale_version`.
 *
 * A retry after a lost response is answered 409 `stage_changed` carrying the
 * decision already recorded (contract § decision, "Idempotency"): when that is
 * THIS decision on THIS version it was recorded, and the success path runs
 * (PR #392 review C3) — when the member recorded it themselves (`byCaller`,
 * review D6). While the READ_ONLY_MODE write freeze is on, the proxy's 503 is
 * main #390's read-only warning — its title AND "nothing was changed" — said
 * INSIDE the open dialog only, in the warning tone and focused (review C1,
 * D4/D5): the dialog stays open (nothing changed, a retry after the freeze is
 * still valid), and a toast would sit behind the modal, hidden from AT.
 *
 * Refusals: a 409 (`stage_changed`, `stale_version`, `sending_started`) or a
 * 404 means the page is stale — the dialog closes FIRST, then a toast says
 * why (so it is not born under the modal's aria-hidden outside) and the page
 * refreshes into the stage the E-Blast is really at. Everything else (422,
 * 429, 5xx, a network failure) keeps the dialog open and is said INSIDE it
 * (`role="alert"`, focused — ux-standards § 6.4); a 422 on the reason marks
 * and focuses that field. Each refusal carries a `seq`, so a repeat is a new
 * node and is announced again. On success the dialog closes and the page
 * refreshes: the stage banner — the page's one live region — announces the
 * new stage, with no toast on top (the same news said twice).
 *
 * Focus: every dialog returns focus to its trigger on Cancel / Escape; on a
 * close that refreshes the page the trigger may unmount, so the shared
 * resolver lands on `#main-content` instead (WCAG 2.4.3). Busy controls are
 * `focusableWhenDisabled` — they turn unavailable while they hold focus — and
 * the fields turn read-only, never `disabled`, for the same reason.
 */
import { useRef, useState, useTransition } from 'react';
import { CircleCheck, Loader2Icon, MessageSquareWarning, Undo2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from '@/lib/toast';
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
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { CancelBroadcastAction } from '@/components/broadcast/cancel-broadcast-action';
import {
  ReasonConfirmationDialog,
  useDialogFinalFocus,
} from '@/components/broadcast/reason-confirmation-dialog';
import { isReadOnlyResponse } from '@/lib/http/read-only-refusal';
import { cn } from '@/lib/utils';
import { approvalErrorMessage, isRecordedDecision, readRouteError } from './approval-error';
import { InlineError } from './inline-error';
import { InlineWarning } from './inline-warning';
import { useFocusRefusal } from './use-focus-refusal';

/** FR-009 — the approval's optional note. */
const NOTE_MAX = 500;
/** FR-010 — a request for changes / a withdrawal, the rejection bounds. */
const REASON_MAX = 2000;

type Decision = 'approved' | 'changes_requested' | 'approval_withdrawn';

export interface MemberSignOffActionsProps {
  readonly broadcastId: string;
  /** The E-Blast's subject — the Withdraw E-Blast typed confirmation. */
  readonly subject: string;
  /** The latest version sent to the member — what every decision names. Null when none was sent. */
  readonly version: { readonly id: string; readonly versionNo: number } | null;
  /** Approve + Request changes: the member's turn, on a sent version. */
  readonly canDecide: boolean;
  /** An approval in force (`member_approved` / `approved`, round ≥ 1). */
  readonly canWithdrawApproval: boolean;
  /** The Domain `canCancel` cut-off. */
  readonly canWithdrawEblast: boolean;
}

/**
 * What a refused decision shows: a message, and whether it belongs to the
 * reason/note field. `tone: 'warning'` + `description` — the read-only freeze
 * (D4), a form-level warning rather than an error.
 */
interface RouteRefusal {
  readonly message: string;
  readonly field: 'reason' | null;
  readonly tone?: 'warning' | undefined;
  readonly description?: string | undefined;
}

/** A refusal on screen; `seq` makes a repeat a new node, announced again. */
type Refusal = (RouteRefusal & { readonly seq: number }) | null;

type Outcome = { readonly kind: 'closed' } | { readonly kind: 'refused'; readonly refusal: RouteRefusal };

export function MemberSignOffActions({
  broadcastId,
  subject,
  version,
  canDecide,
  canWithdrawApproval,
  canWithdrawEblast,
}: MemberSignOffActionsProps): React.ReactElement | null {
  const t = useTranslations('portal.broadcasts.approval.actions');
  const tErrors = useTranslations('portal.broadcasts.approval.errors');
  // D4 — main #390's read-only warning, word for word (root `errors`).
  const tReadOnly = useTranslations('errors');
  const router = useRouter();

  const decide = version !== null && canDecide;
  const withdraw = version !== null && canWithdrawApproval;

  /**
   * One POST, one mapping. The caller owns its dialog and hands over how to
   * close it: on success and on a stale page this closes it (before any
   * toast), otherwise it returns the refusal for the dialog to keep.
   */
  async function post(decision: Decision, reason: string | null, close: () => void): Promise<Outcome> {
    if (version === null) {
      close();
      return { kind: 'closed' };
    }
    try {
      const res = await fetch(`/api/broadcasts/${broadcastId}/decision`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionId: version.id, decision, reason }),
      });
      if (await isReadOnlyResponse(res)) {
        // D5 — the dialog stays open, so it is the ONE channel (no toast).
        return {
          kind: 'refused',
          refusal: {
            message: tReadOnly('readOnlyMode'),
            description: tReadOnly('readOnlyNothingChanged'),
            field: null,
            tone: 'warning',
          },
        };
      }
      const { code, fields, details } = await readRouteError(res);
      if (res.ok || (res.status === 409 && code === 'stage_changed' && isRecordedDecision(details, decision, version.id))) {
        // The refreshed stage banner announces the new stage (L2: no toast).
        close();
        router.refresh();
        return { kind: 'closed' };
      }
      const message = approvalErrorMessage(tErrors, code);
      if (res.status === 409 || res.status === 404) {
        // The page is stale — the stage moved, a newer version exists, or
        // sending began. Close first (L1), say so, re-render the real stage.
        close();
        toast.error(message);
        router.refresh();
        return { kind: 'closed' };
      }
      return { kind: 'refused', refusal: { message, field: fields.includes('reason') ? 'reason' : null } };
    } catch {
      return { kind: 'refused', refusal: { message: approvalErrorMessage(tErrors, null), field: null } };
    }
  }

  if (!decide && !withdraw) {
    // Nothing to decide: today's single right-aligned Withdraw E-Blast.
    return canWithdrawEblast ? (
      <div className="flex justify-end">
        <CancelBroadcastAction broadcastId={broadcastId} surface="member" subject={subject} />
      </div>
    ) : null;
  }

  return (
    <section aria-labelledby="eblast-sign-off-title" data-testid="eblast-sign-off">
      <Card>
        <CardHeader>
          <h2 id="eblast-sign-off-title" className="font-heading text-base font-medium leading-snug">
            {t('title')}
          </h2>
          <CardDescription>
            {decide
              ? t('decideDescription', { version: version?.versionNo ?? 0 })
              : t('withdrawDescription', { version: version?.versionNo ?? 0 })}
          </CardDescription>
        </CardHeader>
        {/* L10 — one full-width button per row on a phone (320 px leaves
            ~224 px of card content), a wrapping row from `sm`. */}
        <CardContent className="grid gap-2 sm:flex sm:flex-wrap sm:items-center">
          {decide ? (
            <>
              <ApproveAction versionNo={version?.versionNo ?? 0} post={post} />
              <ReasonAction
                testId="eblast-request-changes"
                decision="changes_requested"
                namespace="portal.broadcasts.approval.requestChanges"
                label={t('requestChanges')}
                icon={<MessageSquareWarning className="size-4" aria-hidden="true" />}
                tone="primary"
                post={post}
              />
            </>
          ) : null}
          {withdraw ? (
            <ReasonAction
              testId="eblast-withdraw-approval"
              decision="approval_withdrawn"
              namespace="portal.broadcasts.approval.withdrawApproval"
              label={t('withdrawApproval')}
              icon={<Undo2 className="size-4" aria-hidden="true" />}
              tone="destructive"
              post={post}
            />
          ) : null}
          {canWithdrawEblast ? (
            <div className="grid sm:ml-auto sm:block">
              <CancelBroadcastAction broadcastId={broadcastId} surface="member" subject={subject} />
            </div>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}

type Post = (decision: Decision, reason: string | null, close: () => void) => Promise<Outcome>;

function ApproveAction({ versionNo, post }: { readonly versionNo: number; readonly post: Post }): React.ReactElement {
  const t = useTranslations('portal.broadcasts.approval.approveDialog');
  const tActions = useTranslations('portal.broadcasts.approval.actions');
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [refusal, setRefusal] = useState<Refusal>(null);
  const [pending, startTransition] = useTransition();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const seqRef = useRef(0);
  const closedViaSuccessRef = useRef(false);
  const finalFocus = useDialogFinalFocus(triggerRef, undefined, closedViaSuccessRef);
  useFocusRefusal(refusal, 'eblast-approve-error', noteRef);

  const overCap = note.length > NOTE_MAX;
  const noteError = overCap ? t('noteTooLong') : refusal?.field === 'reason' ? refusal.message : null;
  const formError = refusal !== null && refusal.field === null ? refusal.message : null;

  function confirm(): void {
    if (pending || overCap) return;
    setRefusal(null);
    startTransition(async () => {
      const trimmed = note.trim();
      const outcome = await post('approved', trimmed === '' ? null : trimmed, () => {
        closedViaSuccessRef.current = true;
        setOpen(false);
      });
      if (outcome.kind === 'refused') setRefusal({ ...outcome.refusal, seq: ++seqRef.current });
    });
  }

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        className="w-full sm:w-auto"
        data-testid="eblast-approve"
        onClick={() => {
          closedViaSuccessRef.current = false;
          setNote('');
          setRefusal(null);
          setOpen(true);
        }}
      >
        <CircleCheck className="size-4" aria-hidden="true" />
        {tActions('approve')}
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!pending) setOpen(next);
        }}
      >
        <AlertDialogContent finalFocus={finalFocus} initialFocus={cancelRef}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('title', { version: versionNo })}</AlertDialogTitle>
            <AlertDialogDescription>{t('description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="eblast-approve-note">{t('noteLabel')}</Label>
            <Textarea
              id="eblast-approve-note"
              ref={noteRef}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('notePlaceholder')}
              rows={3}
              readOnly={pending}
              aria-invalid={noteError !== null || undefined}
              aria-describedby={
                noteError !== null
                  ? 'eblast-approve-note-error eblast-approve-note-help eblast-approve-note-counter'
                  : 'eblast-approve-note-help eblast-approve-note-counter'
              }
            />
            {/* L4 — the error sits immediately under the field it describes. */}
            {noteError !== null ? (
              <InlineError
                key={overCap ? 'too-long' : `refusal-${refusal?.seq ?? 0}`}
                id="eblast-approve-note-error"
                message={noteError}
              />
            ) : null}
            <p id="eblast-approve-note-help" className="text-xs text-muted-foreground">
              {t('noteHelp')}
            </p>
            <p
              id="eblast-approve-note-counter"
              className={cn('text-xs tabular-nums', overCap ? 'font-semibold text-destructive' : 'text-muted-foreground')}
            >
              {note.length} / {NOTE_MAX}
            </p>
          </div>
          {formError === null ? null : refusal?.tone === 'warning' ? (
            <InlineWarning
              key={`refusal-${refusal.seq}`}
              id="eblast-approve-error"
              title={formError}
              description={refusal.description}
            />
          ) : (
            <InlineError key={`refusal-${refusal?.seq ?? 0}`} id="eblast-approve-error" message={formError} />
          )}
          <AlertDialogFooter>
            <AlertDialogCancel ref={cancelRef} disabled={pending}>
              {t('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="eblast-approve-confirm"
              disabled={pending || overCap}
              focusableWhenDisabled
              aria-busy={pending || undefined}
              onClick={(e) => {
                e.preventDefault();
                confirm();
              }}
            >
              {pending ? <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : null}
              {t('confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function ReasonAction({
  testId,
  decision,
  namespace,
  label,
  icon,
  tone,
  post,
}: {
  readonly testId: string;
  readonly decision: 'changes_requested' | 'approval_withdrawn';
  readonly namespace: string;
  readonly label: string;
  readonly icon: React.ReactNode;
  /** `primary` — a normal, reversible step (outline trigger, primary Confirm); `destructive` — the red tier. */
  readonly tone: 'primary' | 'destructive';
  readonly post: Post;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [refusal, setRefusal] = useState<Refusal>(null);
  const seqRef = useRef(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closedViaSuccessRef = useRef(false);
  const finalFocus = useDialogFinalFocus(triggerRef, undefined, closedViaSuccessRef);

  async function onConfirm(reason: string): Promise<void> {
    // Runs inside the shared dialog's transition: this clear does not commit
    // before the next refusal lands, so the refusal's `seq` (the dialog keys
    // its error node on it) is what makes a repeat announce again (M1).
    setRefusal(null);
    const outcome = await post(decision, reason.trim(), () => {
      closedViaSuccessRef.current = true;
      setOpen(false);
    });
    if (outcome.kind === 'refused') setRefusal({ ...outcome.refusal, seq: ++seqRef.current });
  }

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        variant={tone === 'primary' ? 'outline' : 'destructive-outline'}
        className="w-full sm:w-auto"
        data-testid={testId}
        onClick={() => {
          closedViaSuccessRef.current = false;
          setRefusal(null);
          setOpen(true);
        }}
      >
        {icon}
        {label}
      </Button>
      <ReasonConfirmationDialog
        open={open}
        onOpenChange={setOpen}
        namespace={namespace}
        maxLength={REASON_MAX}
        reasonRequired
        fieldIdPrefix={`${testId}-reason`}
        textareaRows={4}
        onConfirm={onConfirm}
        finalFocus={finalFocus}
        announceBlankReason
        refusal={refusal}
        confirmTone={tone}
      />
    </>
  );
}
