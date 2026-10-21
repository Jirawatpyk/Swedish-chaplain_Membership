'use client';

/**
 * F119 T063 (US1-AS1, US1-AS2, FR-001..FR-006, FR-033, FR-039) — the staff
 * writing surface for the working copy of an E-Blast in "In design".
 *
 * Reuses — never forks — the PR-1 writing tool: the SAME lazy Tiptap editor
 * (`tiptap-editor.tsx` through `loadTiptapEditor`, images to the staff
 * `…/[id]/images` route which accepts `in_design` since T106a), the SAME
 * `PreviewPane` against `POST /api/admin/broadcasts/preview`, the SAME
 * subject counter and unsaved-changes guard as both compose forms. The
 * member's original sits beside it, rendered read-only through the shared
 * sandboxed `PreviewSurface` (the server renders it; nothing here can edit
 * it — FR-001, FR-002).
 *
 * Save is `PATCH …/version` with the optimistic-concurrency token
 * `expectedUpdatedAt` (FR-033): a second marketing user's save loses with 409
 * `version_changed`, which is shown as "someone else changed this" with a
 * reload that says it discards the edits — never a silent overwrite. "Send to
 * member" saves pending edits first, then `POST …/version/send` carrying the
 * same token (round-4 B1 — the one that save returned, else the one loaded or
 * last saved), behind a confirmation because the version becomes read-only the
 * moment it is sent (FR-003).
 *
 * Focus (UX review H2): Save, Send and the test copy turn unavailable while
 * they hold focus, so they are `focusableWhenDisabled` (`aria-disabled`), never
 * natively `disabled` — that drops focus to `<body>`. A FAILED send closes its
 * dialog onto what needs fixing: the field the refusal names (the body's own
 * error line, since the editor exposes no focus handle), Reload on a conflict,
 * or the form-level line. Each refusal renders under its field (§ 4.1), is
 * cleared at the start of every request so a repeat is announced again, and
 * is the ONLY channel for it — no toast on top.
 *
 * The READ_ONLY_MODE write freeze (PR #392 review C1) is not a refusal of the
 * content: nothing was saved or sent and a retry now cannot help, so it is
 * main #390's read-only warning toast — after the send dialog has closed back
 * onto Send, so the toast is not born under the modal.
 *
 * The page mounts this island with `key={updatedAt}`, so a reload after a
 * conflict remounts it from the server's current copy.
 *
 * Enter (T086a V8): the fields are one `<form>` whose submit button is Save, so
 * Enter in the subject saves exactly as Save does — and does nothing while Save
 * is unavailable (`aria-disabled` cancels the implicit click). Enter in the
 * note (`<textarea>`) and in the body (a contenteditable) is a new line, never
 * a submit; the editor's link / button / alt-text dialogs are portaled out of
 * the form, so their inputs have no form to submit. Send stays `type="button"`:
 * it confirms first.
 */
import { useCallback, useDeferredValue, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Send } from 'lucide-react';
import { Alert, Button, Card, Dialog, TextField, Textarea } from '@jirawatpyk/aura-react';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { loadTiptapEditor } from '@/components/shell/tiptap-loader';
import { UnsavedChangesGuard } from '@/components/shell/unsaved-changes-guard';
import { useDialogFinalFocus } from '@/components/broadcast/reason-confirmation-dialog';
import { PreviewPane } from '@/components/broadcast/preview-pane';
import { PreviewSurface, type PreviewState } from '@/components/broadcast/use-preview-html';
import { DETAIL_PREVIEW_FRAME_HEIGHT } from '@/components/broadcast/preview-frame-heights';
import { SUBJECT_MAX_LENGTH } from '@/components/broadcast/compose/subject-counter';
import { OriginalDisclosure } from '@/components/broadcast/admin/original-disclosure';
import { EmailFrame } from '@/components/broadcast/email-frame';
import { useComposeDirtyGuard } from '@/components/broadcast/compose/use-compose-dirty-guard';
import { useReadOnlyToast } from '@/components/shell/use-read-only-toast';
import { isReadOnlyResponse } from '@/lib/http/read-only-refusal';
import { approvalErrorMessage, readRouteError, type RouteError } from './approval-error';
import { InlineError } from './inline-error';
import { TestCopyButton } from './test-copy-button';
import { formatLocalisedDate, TIME_HH_MM } from '@/lib/format-date-localised';

const TiptapEditor = loadTiptapEditor<{
  initialHtml: string;
  onChange: (html: string) => void;
  disabled?: boolean;
  labelledById?: string;
  describedById?: string;
  invalid?: boolean;
  imagesEnabled?: boolean;
  draftId?: string | null;
  imageUploadUrl?: string;
}>(() => import('../tiptap-editor'));

/** FR-006 — the route's zod bound; the DB CHECK is never the one that answers. */
export const NOTE_TO_MEMBER_MAX = 1_000;

const SUBJECT_ID = 'eblast-format-subject';
const BODY_LABEL_ID = 'eblast-format-body-label';
const NOTE_ID = 'eblast-format-note';
/** One error line per field, directly under it (§ 4.1); `null` = the end of the form. */
const ERROR_IDS = {
  subject: 'eblast-format-subject-error',
  body: 'eblast-format-body-error',
  note: 'eblast-format-note-error',
  form: 'eblast-format-error',
} as const;
/**
 * Footer buttons wrap their label below `sm` rather than overflow a 320 px
 * screen (SV runs long). A wrapped button grows; it never drops below the
 * 44 px touch height its `touchHeight` gives (spec 122 US12c-1).
 */
const FOOTER_BUTTON = 'max-sm:h-auto max-sm:min-h-11 max-sm:whitespace-normal';

/** Which field a refusal belongs to, so the message lands where the problem is. */
type ErrorField = 'subject' | 'body' | 'note' | null;
/** Where focus goes when a send fails: the refused field, or Reload on a conflict. */
type FailFocus = ErrorField | 'conflict';
type SaveOutcome =
  /** `updatedAt` — the concurrency token the save returned (round-4 B1: the send that follows carries it). */
  | { readonly kind: 'saved'; readonly updatedAt: string }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'refused'; readonly field: ErrorField }
  /** The READ_ONLY_MODE freeze — nothing saved; the caller says so (#390). */
  | { readonly kind: 'read_only' };

const BODY_CODES: ReadonlySet<string> = new Set([
  'unsafe_content',
  'image_source_not_allowlisted',
  'cta_text_length',
  'too_many_cta',
  'cta_link_scheme',
  'banner_alt_required',
]);

function fieldOf(error: RouteError): ErrorField {
  if (error.code !== null && BODY_CODES.has(error.code)) return 'body';
  if (error.fields.includes('subject')) return 'subject';
  if (error.fields.includes('noteToMember')) return 'note';
  if (error.fields.includes('bodyHtml')) return 'body';
  return null;
}

export interface WorkingCopyView {
  readonly id: string;
  readonly versionNo: number;
  readonly subject: string;
  readonly bodyHtml: string;
  readonly noteToMember: string | null;
  /** ISO — the optimistic-concurrency token. */
  readonly updatedAt: string;
}

export interface FormattedVersionWorkspaceProps {
  readonly broadcastId: string;
  readonly workingCopy: WorkingCopyView;
  readonly original: { readonly subject: string; readonly preview: PreviewState };
  readonly imagesEnabled: boolean;
}

export function FormattedVersionWorkspace({
  broadcastId,
  workingCopy,
  original,
  imagesEnabled,
}: FormattedVersionWorkspaceProps): React.ReactElement {
  const t = useTranslations('admin.broadcasts.approval.workspace');
  const tContent = useTranslations('admin.broadcasts.approval.content');
  const tSend = useTranslations('admin.broadcasts.approval.send');
  const tFields = useTranslations('portal.broadcasts.compose.fields');
  const tErrors = useTranslations('admin.broadcasts.approval.errors');
  const locale = useLocale();
  const router = useRouter();
  const readOnlyToast = useReadOnlyToast();

  const [subject, setSubject] = useState(workingCopy.subject);
  const [bodyHtml, setBodyHtml] = useState(workingCopy.bodyHtml);
  const [note, setNote] = useState(workingCopy.noteToMember ?? '');
  const [savedNote, setSavedNote] = useState(workingCopy.noteToMember ?? '');
  const [token, setToken] = useState(workingCopy.updatedAt);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<{ readonly message: string; readonly field: ErrorField } | null>(null);
  const [sendOpen, setSendOpen] = useState(false);

  const sendTriggerRef = useRef<HTMLButtonElement>(null);
  const reloadRef = useRef<HTMLButtonElement>(null);
  const closedViaSuccessRef = useRef(false);
  const failFocusRef = useRef<FailFocus | undefined>(undefined);
  const triggerFinalFocus = useDialogFinalFocus(sendTriggerRef, undefined, closedViaSuccessRef);
  // Read at close, from a ref (a value captured in state would be stale by
  // then): a failed send sets `failFocusRef` in the same commit that renders
  // the error line and closes the dialog, so the target exists once the close
  // has committed. Focus it ourselves after Base UI's own microtask and answer
  // `false` ("move nothing") — Base UI returns focus only to a TABBABLE node,
  // and an error line is focusable, not tabbable.
  const sendFinalFocus = useCallback((): HTMLElement | false | null => {
    const target = failFocusRef.current;
    if (target === undefined) return triggerFinalFocus();
    failFocusRef.current = undefined;
    queueMicrotask(() => {
      queueMicrotask(() => {
        const el =
          target === 'conflict'
            ? reloadRef.current
            : document.getElementById(
                target === 'subject' ? SUBJECT_ID : target === 'note' ? NOTE_ID : ERROR_IDS[target ?? 'form'],
              );
        el?.focus();
      });
    });
    return false;
  }, [triggerFinalFocus]);

  // M6 — the conflict notice takes focus when it appears (a failed Save leaves
  // focus on Save otherwise, and Reload is the only way forward).
  useEffect(() => {
    if (conflict) reloadRef.current?.focus();
  }, [conflict]);

  const busy = saving || sending;
  const guard = useComposeDirtyGuard(
    { subject, bodyHtml },
    { initial: { subject: workingCopy.subject, bodyHtml: workingCopy.bodyHtml }, suspended: sending },
  );
  const dirty = guard.dirty || note !== savedNote;
  const deferredBody = useDeferredValue(bodyHtml);

  /** One save; the copy on the server equals the screen only on `saved`. */
  async function save(): Promise<SaveOutcome> {
    const snapshot = { subject, bodyHtml };
    const noteToMember = note.trim() === '' ? null : note;
    const res = await fetch(`/api/admin/broadcasts/${broadcastId}/version`, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject,
        bodyHtml,
        bodySource: bodyHtml,
        noteToMember,
        expectedUpdatedAt: token,
      }),
    });
    if (res.ok) {
      const body = (await res.json()) as { version?: { updatedAt?: unknown } };
      const updatedAt = typeof body.version?.updatedAt === 'string' ? body.version.updatedAt : token;
      setToken(updatedAt);
      guard.markSaved(snapshot);
      setSavedNote(note);
      return { kind: 'saved', updatedAt };
    }
    if (await isReadOnlyResponse(res)) return { kind: 'read_only' };
    const refusal = await readRouteError(res);
    if (refusal.code === 'version_changed') {
      setConflict(true);
      return { kind: 'conflict' };
    }
    if (refusal.code === 'stage_changed' || refusal.code === 'broadcast_not_found') {
      toast.error(approvalErrorMessage(tErrors, refusal.code));
      router.refresh();
      return { kind: 'stale' };
    }
    const field = fieldOf(refusal);
    setError({ message: approvalErrorMessage(tErrors, refusal.code), field });
    return { kind: 'refused', field };
  }

  async function onSave(): Promise<void> {
    if (busy || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      const outcome = await save();
      if (outcome.kind === 'saved') toast.success(t('saved'));
      else if (outcome.kind === 'read_only') readOnlyToast();
    } catch {
      setError({ message: approvalErrorMessage(tErrors, null), field: null });
    } finally {
      setSaving(false);
    }
  }

  /** Close the send dialog onto what needs fixing (see `sendFinalFocus`). */
  function closeSendOnto(target: FailFocus): void {
    failFocusRef.current = target;
    setSendOpen(false);
  }

  async function onSend(): Promise<void> {
    if (busy) return;
    setSending(true);
    setError(null);
    try {
      // FR-033 (round-4 B1) — the send carries the concurrency token, so a
      // copy another marketing user saved since this screen loaded is refused
      // `version_changed`, never sent unseen. When Send saves first it is the
      // token THAT save returned (`token` in this closure is still the old one
      // — sending it would make the happy path answer 409 to itself).
      let expectedUpdatedAt = token;
      if (dirty) {
        const outcome = await save();
        if (outcome.kind === 'stale') {
          closedViaSuccessRef.current = true;
          setSendOpen(false);
          return;
        }
        if (outcome.kind === 'read_only') {
          // Close first (back onto Send, which survives), then say it.
          setSendOpen(false);
          readOnlyToast();
          return;
        }
        if (outcome.kind === 'conflict') {
          closeSendOnto('conflict');
          return;
        }
        if (outcome.kind === 'refused') {
          closeSendOnto(outcome.field);
          return;
        }
        expectedUpdatedAt = outcome.updatedAt;
      }
      const res = await fetch(`/api/admin/broadcasts/${broadcastId}/version/send`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedUpdatedAt }),
      });
      if (res.ok) {
        closedViaSuccessRef.current = true;
        setSendOpen(false);
        toast.success(tSend('sent'));
        router.refresh();
        return;
      }
      if (await isReadOnlyResponse(res)) {
        setSendOpen(false);
        readOnlyToast();
        return;
      }
      const refusal = await readRouteError(res);
      const message = approvalErrorMessage(tErrors, refusal.code);
      if (res.status === 409 && refusal.code === 'stage_changed') {
        closedViaSuccessRef.current = true;
        setSendOpen(false);
        toast.error(message);
        router.refresh();
        return;
      }
      if (refusal.code === 'version_changed') {
        setConflict(true);
        closeSendOnto('conflict');
        return;
      }
      // Content refusals keep the version editable: say so where the problem is.
      const field = fieldOf(refusal);
      setError({ message, field });
      closeSendOnto(field);
    } catch {
      setError({ message: approvalErrorMessage(tErrors, null), field: null });
      closeSendOnto(null);
    } finally {
      setSending(false);
    }
  }

  const errorFor = (field: ErrorField): string | null => (error !== null && error.field === field ? error.message : null);
  // AURA's fields describe themselves by their hint; the refusal line under a
  // field joins it (`aria-describedby` is merged by the field).
  const describedBy = (field: Exclude<ErrorField, null>): string | undefined =>
    error?.field === field ? ERROR_IDS[field] : undefined;
  const subjectError = errorFor('subject');
  const bodyError = errorFor('body');
  const noteError = errorFor('note');
  const formError = errorFor(null);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,600px)] lg:items-start">
      <UnsavedChangesGuard armed={dirty && !sending} />
      {/* Spec 122 US12c-1 (board `Admin-eblast-design`) — an AURA card,
          labelled by its own h2, holding AURA fields and buttons. */}
      <Card
        data-testid="eblast-format-workspace"
        className="min-w-0"
        titleId="eblast-format-title"
        title={t('title', { version: workingCopy.versionNo })}
        headingLevel={2}
        description={t('description')}
      >
        <form
          className="flex flex-col gap-[var(--aura-space-4)]"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void onSave();
          }}
        >
          {conflict ? (
            <Alert
              tone="warning"
              title={t('conflictTitle')}
              data-testid="eblast-format-conflict"
              action={
                <Button
                  ref={reloadRef}
                  type="button"
                  variant="secondary"
                  touchHeight
                  className={FOOTER_BUTTON}
                  onClick={() => router.refresh()}
                >
                  {t('reload')}
                </Button>
              }
            >
              {t('conflictBody')}
            </Alert>
          ) : null}

          <div className="flex flex-col gap-[var(--aura-space-2)]">
            <TextField
              id={SUBJECT_ID}
              touchHeight
              label={t('subjectLabel')}
              hint={tFields('subjectCounter', { count: subject.length, max: SUBJECT_MAX_LENGTH })}
              value={subject}
              maxLength={SUBJECT_MAX_LENGTH}
              disabled={busy}
              invalid={subjectError !== null}
              aria-describedby={describedBy('subject')}
              onChange={(e) => {
                setSubject(e.target.value);
                if (error?.field === 'subject') setError(null);
              }}
            />
            {subjectError !== null ? <InlineError id={ERROR_IDS.subject} message={subjectError} /> : null}
          </div>

          <div className="flex flex-col gap-[var(--aura-space-2)]">
            <span id={BODY_LABEL_ID} className="text-sm font-medium text-[var(--aura-fg-primary)]">
              {t('bodyLabel')}
            </span>
            <TiptapEditor
              initialHtml={workingCopy.bodyHtml}
              onChange={(next) => {
                setBodyHtml(next);
                if (error?.field === 'body') setError(null);
              }}
              disabled={busy}
              labelledById={BODY_LABEL_ID}
              invalid={bodyError !== null}
              {...(bodyError !== null ? { describedById: ERROR_IDS.body } : {})}
              imagesEnabled={imagesEnabled}
              draftId={broadcastId}
              imageUploadUrl={`/api/admin/broadcasts/${broadcastId}/images`}
            />
            {bodyError !== null ? <InlineError id={ERROR_IDS.body} message={bodyError} /> : null}
          </div>

          <div className="flex flex-col gap-[var(--aura-space-2)]">
            <Textarea
              id={NOTE_ID}
              label={t('noteLabel')}
              hint={t('noteHelp', { count: note.length, max: NOTE_TO_MEMBER_MAX })}
              value={note}
              maxLength={NOTE_TO_MEMBER_MAX}
              rows={3}
              disabled={busy}
              invalid={noteError !== null}
              aria-describedby={describedBy('note')}
              onChange={(e) => {
                setNote(e.target.value);
                if (error?.field === 'note') setError(null);
              }}
            />
            {noteError !== null ? <InlineError id={ERROR_IDS.note} message={noteError} /> : null}
          </div>

          {formError !== null ? <InlineError id={ERROR_IDS.form} message={formError} /> : null}

          {/* Left to right from 640px: test copy, Save, Send to member. Below
              640px board `Admin-eblast-design-mobile` stacks the next step
              first: Send, Save, test copy (maintainer, parity 20 Oct). */}
          <div className="flex flex-col gap-2 border-t border-[var(--aura-border-default)] pt-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
            {guard.savedAt !== null ? (
              // Not a live region: the save's toast is the one announcement.
              <p className="aura-text-caption text-[var(--aura-fg-secondary)] max-sm:order-first sm:mr-auto">
                {t('savedAt', { time: formatLocalisedDate(guard.savedAt, locale, TIME_HH_MM) })}
              </p>
            ) : null}
            <TestCopyButton
              broadcastId={broadcastId}
              versionId={workingCopy.id}
              subject={subject}
              bodyHtml={bodyHtml}
              disabled={busy}
              className={cn(FOOTER_BUTTON, 'max-sm:order-3')}
            />
            <Button
              // The form's submit — its `onSubmit` runs `onSave` (a click and
              // Enter in the subject both arrive there, once).
              type="submit"
              variant="secondary"
              touchHeight
              data-testid="eblast-format-save"
              className={cn(FOOTER_BUTTON, 'max-sm:order-2')}
              loading={saving}
              aria-disabled={busy || !dirty || undefined}
            >
              {t('save')}
            </Button>
            <Button
              ref={sendTriggerRef}
              type="button"
              variant="primary"
              touchHeight
              icon={<Send aria-hidden />}
              data-testid="eblast-send-to-member"
              className={cn(FOOTER_BUTTON, 'max-sm:order-1')}
              aria-disabled={busy || conflict || undefined}
              onClick={() => {
                if (busy || conflict) return;
                closedViaSuccessRef.current = false;
                failFocusRef.current = undefined;
                setSendOpen(true);
              }}
            >
              {tSend('button')}
            </Button>
          </div>
        </form>
      </Card>

      <div className="min-w-0 space-y-6 lg:sticky lg:top-[calc(var(--shell-bar-height,0px)+1rem)] lg:self-start">
        <PreviewPane subject={subject} bodyHtml={deferredBody} endpoint="/api/admin/broadcasts/preview" locale={locale} />
        {/* Board `Admin-eblast-design-mobile` (maintainer, 19 Oct) — folded
            under its title where the columns stack. */}
        <OriginalDisclosure summary={tContent('originalTitle')}>
          <Card
            data-testid="eblast-member-original"
            titleId="eblast-original-title"
            title={tContent('originalTitle')}
            headingLevel={2}
            description={tContent('originalHint')}
          >
            <div className="space-y-2">
              <p className="text-sm font-medium break-words">{original.subject}</p>
              <EmailFrame>
                <PreviewSurface state={original.preview} height={DETAIL_PREVIEW_FRAME_HEIGHT} fit />
              </EmailFrame>
            </div>
          </Card>
        </OriginalDisclosure>
      </div>

      <Dialog
        role="alertdialog"
        open={sendOpen}
        dismissible={!sending}
        onClose={() => {
          if (!sending) setSendOpen(false);
        }}
        finalFocus={() => sendFinalFocus() || null}
        title={tSend('title')}
        description={
          <>
            {tSend('body')}
            {dirty ? (
              <span className="mt-[var(--aura-space-2)] block text-[var(--aura-fg-primary)]">{tSend('savesFirst')}</span>
            ) : null}
          </>
        }
        footer={
          <>
            <Button touchHeight variant="secondary" disabled={sending} onClick={() => setSendOpen(false)}>
              {tSend('cancel')}
            </Button>
            <Button touchHeight
              data-testid="eblast-send-to-member-confirm"
              variant="primary"
              icon="mail"
              loading={sending}
              onClick={() => void onSend()}
            >
              {tSend('confirm')}
            </Button>
          </>
        }
      />
    </div>
  );
}
