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
 * reload — never a silent overwrite. "Send to member" saves pending edits
 * first, then `POST …/version/send`, behind a confirmation because the
 * version becomes read-only the moment it is sent (FR-003).
 *
 * The page mounts this island with `key={updatedAt}`, so a reload after a
 * conflict remounts it from the server's current copy.
 */
import { useDeferredValue, useRef, useState } from 'react';
import { Loader2Icon, Save, Send } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
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
import { InlineAlert, InlineAlertDescription, InlineAlertTitle } from '@/components/ui/inline-alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { loadTiptapEditor } from '@/components/ui/tiptap-loader';
import { UnsavedChangesGuard } from '@/components/shell/unsaved-changes-guard';
import { useDialogFinalFocus } from '@/components/broadcast/reason-confirmation-dialog';
import { PreviewPane } from '@/components/broadcast/preview-pane';
import { PreviewSurface, type PreviewState } from '@/components/broadcast/use-preview-html';
import { DETAIL_PREVIEW_FRAME_HEIGHT } from '@/components/broadcast/preview-frame-heights';
import { SubjectCounter, SUBJECT_MAX_LENGTH } from '@/components/broadcast/compose/subject-counter';
import { useComposeDirtyGuard } from '@/components/broadcast/compose/use-compose-dirty-guard';
import { approvalErrorMessage, readRouteError, type RouteError } from './approval-error';
import { TestCopyButton } from './test-copy-button';

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
const SUBJECT_COUNTER_ID = 'eblast-format-subject-counter';
const BODY_LABEL_ID = 'eblast-format-body-label';
const NOTE_ID = 'eblast-format-note';
const NOTE_HELP_ID = 'eblast-format-note-help';
const ERROR_ID = 'eblast-format-error';
/** `CardTitle`'s type, on a real heading: the shadcn `CardTitle` is a `<div>` (not in the SR heading tree). */
const CARD_HEADING = 'font-heading text-base leading-snug font-medium';

/** Which field a refusal belongs to, so the message lands where the problem is. */
type ErrorField = 'subject' | 'body' | 'note' | null;

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
  const tErrors = useTranslations('admin.broadcasts.approval.errors');
  const format = useFormatter();
  const locale = useLocale();
  const router = useRouter();

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
  const closedViaSuccessRef = useRef(false);
  const sendFinalFocus = useDialogFinalFocus(sendTriggerRef, undefined, closedViaSuccessRef);

  const busy = saving || sending;
  const guard = useComposeDirtyGuard(
    { subject, bodyHtml },
    { initial: { subject: workingCopy.subject, bodyHtml: workingCopy.bodyHtml }, suspended: sending },
  );
  const dirty = guard.dirty || note !== savedNote;
  const deferredBody = useDeferredValue(bodyHtml);

  /** One save. Resolves true when the copy on the server now equals the screen. */
  async function save(): Promise<boolean> {
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
      if (typeof body.version?.updatedAt === 'string') setToken(body.version.updatedAt);
      guard.markSaved(snapshot);
      setSavedNote(note);
      setError(null);
      return true;
    }
    const refusal = await readRouteError(res);
    if (refusal.code === 'version_changed') {
      setConflict(true);
      return false;
    }
    if (refusal.code === 'stage_changed' || refusal.code === 'broadcast_not_found') {
      toast.error(approvalErrorMessage(tErrors, refusal.code));
      router.refresh();
      return false;
    }
    setError({ message: approvalErrorMessage(tErrors, refusal.code), field: fieldOf(refusal) });
    return false;
  }

  async function onSave(): Promise<void> {
    if (busy) return;
    setSaving(true);
    try {
      if (await save()) toast.success(t('saved'));
    } catch {
      setError({ message: approvalErrorMessage(tErrors, null), field: null });
    } finally {
      setSaving(false);
    }
  }

  async function onSend(): Promise<void> {
    if (busy) return;
    setSending(true);
    try {
      if (dirty && !(await save())) {
        setSendOpen(false);
        return;
      }
      const res = await fetch(`/api/admin/broadcasts/${broadcastId}/version/send`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (res.ok) {
        closedViaSuccessRef.current = true;
        setSendOpen(false);
        toast.success(tSend('sent'));
        router.refresh();
        return;
      }
      const refusal = await readRouteError(res);
      const message = approvalErrorMessage(tErrors, refusal.code);
      setSendOpen(false);
      if (res.status === 409 && refusal.code === 'stage_changed') {
        toast.error(message);
        router.refresh();
        return;
      }
      // Content refusals keep the version editable: say so where the problem is.
      setError({ message, field: fieldOf(refusal) });
      toast.error(message);
    } catch {
      setSendOpen(false);
      toast.error(approvalErrorMessage(tErrors, null));
    } finally {
      setSending(false);
    }
  }

  const describedBy = (field: Exclude<ErrorField, null>, base?: string): string | undefined => {
    const ids = [base, error?.field === field ? ERROR_ID : undefined].filter(Boolean);
    return ids.length > 0 ? ids.join(' ') : undefined;
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,600px)]">
      <UnsavedChangesGuard armed={dirty && !sending} />
      <Card
        data-testid="eblast-format-workspace"
        className="min-w-0"
        role="region"
        aria-labelledby="eblast-format-title"
      >
        <CardHeader>
          <h2 id="eblast-format-title" className={CARD_HEADING}>
            {t('title', { version: workingCopy.versionNo })}
          </h2>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {conflict ? (
            <InlineAlert tone="warning" data-testid="eblast-format-conflict">
              <InlineAlertTitle>{t('conflictTitle')}</InlineAlertTitle>
              <InlineAlertDescription className="space-y-2">
                <span className="block">{t('conflictBody')}</span>
                <Button type="button" variant="outline" onClick={() => router.refresh()}>
                  {t('reload')}
                </Button>
              </InlineAlertDescription>
            </InlineAlert>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor={SUBJECT_ID}>{t('subjectLabel')}</Label>
            <Input
              id={SUBJECT_ID}
              value={subject}
              maxLength={SUBJECT_MAX_LENGTH}
              disabled={busy}
              onChange={(e) => {
                setSubject(e.target.value);
                if (error?.field === 'subject') setError(null);
              }}
              aria-invalid={error?.field === 'subject' || undefined}
              aria-describedby={describedBy('subject', SUBJECT_COUNTER_ID)}
            />
            <SubjectCounter id={SUBJECT_COUNTER_ID} value={subject} />
          </div>

          <div className="space-y-2">
            <Label id={BODY_LABEL_ID}>{t('bodyLabel')}</Label>
            <TiptapEditor
              initialHtml={workingCopy.bodyHtml}
              onChange={(next) => {
                setBodyHtml(next);
                if (error?.field === 'body') setError(null);
              }}
              disabled={busy}
              labelledById={BODY_LABEL_ID}
              invalid={error?.field === 'body'}
              {...(error?.field === 'body' ? { describedById: ERROR_ID } : {})}
              imagesEnabled={imagesEnabled}
              draftId={broadcastId}
              imageUploadUrl={`/api/admin/broadcasts/${broadcastId}/images`}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor={NOTE_ID}>{t('noteLabel')}</Label>
            <Textarea
              id={NOTE_ID}
              value={note}
              maxLength={NOTE_TO_MEMBER_MAX}
              rows={3}
              disabled={busy}
              onChange={(e) => {
                setNote(e.target.value);
                if (error?.field === 'note') setError(null);
              }}
              aria-invalid={error?.field === 'note' || undefined}
              aria-describedby={describedBy('note', NOTE_HELP_ID)}
            />
            <p id={NOTE_HELP_ID} className="text-xs text-muted-foreground">
              {t('noteHelp', { count: note.length, max: NOTE_TO_MEMBER_MAX })}
            </p>
          </div>

          {error !== null ? (
            <p id={ERROR_ID} role="alert" className="text-sm text-destructive">
              {error.message}
            </p>
          ) : null}

          <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
            {guard.savedAt !== null ? (
              <p className="text-xs text-muted-foreground sm:mr-auto" aria-live="polite">
                {t('savedAt', { time: format.dateTime(guard.savedAt, { hour: '2-digit', minute: '2-digit' }) })}
              </p>
            ) : null}
            <TestCopyButton
              broadcastId={broadcastId}
              versionId={workingCopy.id}
              subject={subject}
              bodyHtml={bodyHtml}
              disabled={busy}
            />
            <Button
              type="button"
              variant="outline"
              data-testid="eblast-format-save"
              disabled={busy || !dirty}
              aria-busy={saving || undefined}
              onClick={() => {
                void onSave();
              }}
            >
              {saving ? (
                <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" />
              ) : (
                <Save className="size-4" aria-hidden="true" />
              )}
              {t('save')}
            </Button>
            <Button
              ref={sendTriggerRef}
              type="button"
              data-testid="eblast-send-to-member"
              disabled={busy || conflict}
              onClick={() => {
                closedViaSuccessRef.current = false;
                setSendOpen(true);
              }}
            >
              <Send className="size-4" aria-hidden="true" />
              {tSend('button')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="min-w-0 space-y-6 lg:sticky lg:top-4 lg:self-start">
        <PreviewPane subject={subject} bodyHtml={deferredBody} endpoint="/api/admin/broadcasts/preview" locale={locale} />
        <Card data-testid="eblast-member-original" role="region" aria-labelledby="eblast-original-title">
          <CardHeader>
            <h2 id="eblast-original-title" className={CARD_HEADING}>
              {tContent('originalTitle')}
            </h2>
            <CardDescription>{tContent('originalHint')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm font-medium break-words">{original.subject}</p>
            <PreviewSurface state={original.preview} height={DETAIL_PREVIEW_FRAME_HEIGHT} />
          </CardContent>
        </Card>
      </div>

      <AlertDialog
        open={sendOpen}
        onOpenChange={(next) => {
          if (!sending) setSendOpen(next);
        }}
      >
        <AlertDialogContent className="max-w-lg" finalFocus={sendFinalFocus}>
          <AlertDialogHeader>
            <AlertDialogTitle>{tSend('title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {tSend('body')}
              {dirty ? <span className="mt-2 block text-foreground">{tSend('savesFirst')}</span> : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={sending}>{tSend('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="eblast-send-to-member-confirm"
              disabled={sending}
              aria-busy={sending || undefined}
              onClick={(e) => {
                e.preventDefault();
                void onSend();
              }}
            >
              {sending ? <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : null}
              {tSend('confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
