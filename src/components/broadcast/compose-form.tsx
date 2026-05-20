'use client';

/**
 * T081 — Compose form orchestrator.
 *
 * Owns the full compose form state via `react-hook-form` + zod resolver.
 * Wires Tiptap-loader (dynamic-imported), segment-picker, custom-list-input,
 * schedule-picker, preview-pane, submit-button, and quota-display.
 *
 * Submit handler:
 *   - POST /api/broadcasts/submit (compose-and-submit in one call)
 *   - 200 → toast.success + redirect to detail page
 *   - 422 → toast.error with bilingual error message (mapped via
 *     portal.broadcasts.compose.errors.<code>)
 *   - 429 → toast.error retry-later
 *   - 4xx/5xx → toast.error generic
 *
 * `useDeferredValue(bodyHtml)` keeps the editor responsive while the
 * preview pane re-renders.
 */
import { useDeferredValue, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { z } from 'zod';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { loadTiptapEditor } from '@/components/ui/tiptap-loader';
import { SegmentPicker, type SegmentPickerValue } from './segment-picker';
import { CustomListInput, parseLines } from './custom-list-input';
import { SchedulePicker } from './schedule-picker';
import { PreviewPane } from './preview-pane';
import { QuotaDisplay, type QuotaSnapshot } from './quota-display';
import { SubmitButton } from './submit-button';
import { UnsafeImageSourcesList } from './unsafe-image-sources-list';

const TiptapEditor = loadTiptapEditor<{
  initialHtml: string;
  onChange: (html: string) => void;
  disabled?: boolean;
  labelledById?: string;
  imagesEnabled?: boolean;
  draftId?: string | null;
}>(() => import('./tiptap-editor'));

const SubmitSchema = z.object({
  subject: z.string().min(1).max(200),
  bodyHtml: z.string().min(1).max(200 * 1024),
});

/**
 * UX-R2-1 (round-3) — map server error code → focusable field so SR
 * users hear the inline error AT the field, not just in a transient
 * toast (WCAG 3.3.1 + 3.3.3).
 *
 * Round-4 MED-E — form-level errors (quota, rate-limit, halt) clear
 * only on resubmit; field-level errors clear when the user edits THAT
 * field. Distinguishing them prevents the form-level error from
 * disappearing the moment the user types in any unrelated field.
 */
type ServerErrorField = 'subject' | 'body' | 'segment' | 'customList' | null;
const ERROR_CODE_FIELD: Record<string, ServerErrorField> = {
  broadcast_subject_too_long: 'subject',
  broadcast_subject_empty: 'subject',
  broadcast_body_too_large: 'body',
  broadcast_body_unsafe_html: 'body',
  // PR-review fix 2026-05-20 UX-C1 — F7.1a US2 FR-011 + AS2 closure.
  // Field focus jumps to body editor; structured list of disallowed
  // image sources renders below via <UnsafeImageSourcesList /> from
  // route response `error.details.disallowedSources`.
  broadcast_body_image_source_unsafe: 'body',
  broadcast_empty_segment_blocked: 'segment',
  broadcast_audience_too_large: 'segment',
  broadcast_custom_recipient_unknown: 'customList',
  broadcast_custom_recipient_invalid_format: 'customList',
  broadcast_custom_recipient_empty: 'customList',
  broadcast_custom_recipient_too_many: 'customList',
};

/**
 * Simplify-S4 (round-3) — switch instead of nested ternary
 * (CLAUDE.md forbids nested ternaries in presentation layer).
 */
function buildSegmentPayload(
  segment: SegmentPickerValue,
  customLines: ReadonlyArray<string>,
):
  | { kind: 'tier'; tierCodes: ReadonlyArray<string> }
  | { kind: 'custom'; emails: ReadonlyArray<string> }
  | { kind: 'all_members' | 'event_attendees_last_90d' } {
  switch (segment.kind) {
    case 'tier':
      return { kind: 'tier', tierCodes: segment.tierCodes };
    case 'custom':
      return { kind: 'custom', emails: customLines };
    default:
      return { kind: segment.kind };
  }
}

export interface ComposeFormProps {
  readonly initialDraftId?: string | null;
  readonly initialSubject?: string;
  readonly initialBodyHtml?: string;
  readonly initialQuota?: QuotaSnapshot | null;
  /**
   * F7.1a US2 (T078) — when true, the Tiptap editor registers the
   * image extension + renders the inline-image uploader. Resolved
   * server-side via `isF71aUs2Enabled()` so the surface only appears
   * when the kill-switch is fully ON.
   */
  readonly imagesEnabled?: boolean;
}

export function ComposeForm({
  initialDraftId = null,
  initialSubject = '',
  initialBodyHtml = '<p></p>',
  initialQuota = null,
  imagesEnabled = false,
}: ComposeFormProps): React.ReactElement {
  const router = useRouter();
  const t = useTranslations('portal.broadcasts.compose');
  const tErr = useTranslations('portal.broadcasts.compose.errors');

  const [subject, setSubject] = useState<string>(initialSubject);
  const [bodyHtml, setBodyHtml] = useState<string>(initialBodyHtml);
  const [segment, setSegment] = useState<SegmentPickerValue>({
    kind: 'all_members',
    tierCodes: [],
  });
  const [customList, setCustomList] = useState<string>('');
  const [scheduledFor, setScheduledFor] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [quotaRefreshKey, setQuotaRefreshKey] = useState<number>(0);
  const [serverError, setServerError] = useState<{
    field: ServerErrorField;
    message: string;
  } | null>(null);
  // PR-review fix 2026-05-20 UX-C1 — accumulated <img src> URLs the
  // server rejected because their hostname is not in the tenant's
  // image-source allowlist. Cleared when the user edits the body OR
  // re-submits successfully.
  const [unsafeImageSources, setUnsafeImageSources] = useState<
    readonly string[] | null
  >(null);

  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyContainerRef = useRef<HTMLDivElement>(null);

  const deferredBody = useDeferredValue(bodyHtml);

  // UX-3 — beforeunload guard so a member who composed substantial
  // content + accidentally closes the tab gets a browser-native
  // "Are you sure you want to leave?" prompt. Active only when the
  // body OR subject has diverged from the initial draft AND we're
  // not in the middle of submitting (post-submit redirect would
  // false-trigger the prompt).
  useEffect(() => {
    const dirty =
      !submitting &&
      (subject !== initialSubject || bodyHtml !== initialBodyHtml);
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      // Modern browsers ignore the message string and show their own
      // copy; setting returnValue + preventDefault is the cross-
      // browser invocation pattern.
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [submitting, subject, bodyHtml, initialSubject, initialBodyHtml]);

  // UX-R2-1 — auto-focus the failing field when a server error arrives.
  useEffect(() => {
    if (serverError === null) return;
    if (serverError.field === 'subject') subjectRef.current?.focus();
    else if (serverError.field === 'body') bodyContainerRef.current?.focus();
    // segment / customList are radio/textarea — toast suffices
  }, [serverError]);

  const customLines = parseLines(customList);
  const validation = SubmitSchema.safeParse({ subject, bodyHtml });
  const customListValid =
    segment.kind !== 'custom' || (customLines.length > 0 && customLines.length <= 100);
  const tierValid = segment.kind !== 'tier' || segment.tierCodes.length > 0;
  const submitDisabled =
    !validation.success || !customListValid || !tierValid;

  // UX-C2 — per-field error tracking for aria-describedby + aria-invalid.
  // Empty subject/body is the "needs input" state, not an "error" state
  // (don't shout red at users who haven't typed yet); only mark invalid
  // when the user has typed something AND it fails.
  const subjectInvalid = subject.length > 0 && subject.length > 200;
  const bodyInvalid = bodyHtml.length > 200 * 1024;

  async function onSubmit() {
    if (submitting) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const body: Record<string, unknown> = {
        subject,
        bodyHtml,
        bodySource: bodyHtml,
        segment: buildSegmentPayload(segment, customLines),
        scheduledFor,
      };
      if (initialDraftId !== null) body['draftId'] = initialDraftId;

      const res = await fetch('/api/broadcasts/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });

      // PR-review fix 2026-05-20 SF-M1 — distinguish malformed-JSON
      // from network failure. The previous `.catch(() => ({}))` made
      // them indistinguishable in the toast layer. Now: success-path
      // JSON parse failure logs + shows specific toast; error path
      // keeps the silent default.
      let responseBody: {
        error?: {
          code?: string;
          message?: string;
          details?: { disallowedSources?: ReadonlyArray<string> };
        };
        broadcastId?: string;
      } = {};
      try {
        responseBody = (await res.json()) as typeof responseBody;
      } catch (parseErr) {
        if (res.ok) {
          // 2xx with malformed body — server bug, not user fault.
          // Log + treat as failure so the success-redirect path
          // doesn't fire on a missing broadcastId.
           
          console.error(
            { err: String(parseErr), status: res.status },
            'broadcasts.submit.response_invalid_json',
          );
          toast.error(tErr('internal_error'));
          return;
        }
        // Non-2xx + malformed body — fall through to error-mapping
        // with the default empty {} (route was reachable but didn't
        // return JSON; likely 5xx with HTML error page).
      }

      if (res.ok && responseBody.broadcastId) {
        setUnsafeImageSources(null);
        toast.success(t('toast.submitted'), {
          description: t('toast.submittedSlaHint'),
        });
        setQuotaRefreshKey((n) => n + 1);
        router.push(`/portal/benefits/e-blasts?submitted=${responseBody.broadcastId}`);
        router.refresh();
        return;
      }

      const code = responseBody.error?.code ?? 'internal_error';
      // PR-review fix 2026-05-20 UX-C1 — surface accumulated list of
      // disallowed image sources from route payload so the
      // <UnsafeImageSourcesList /> below the editor can render each
      // offender (AS2 + FR-011).
      if (
        code === 'broadcast_body_image_source_unsafe' &&
        Array.isArray(responseBody.error?.details?.disallowedSources)
      ) {
        setUnsafeImageSources(responseBody.error.details.disallowedSources);
      } else {
        setUnsafeImageSources(null);
      }
      // Use the i18n key if recognised; fall back to the server message.
      let msg: string;
      try {
        msg = tErr(code);
      } catch {
        msg = responseBody.error?.message ?? tErr('internal_error');
      }
      // UX-R2-1: surface to the failing field; useEffect will focus.
      setServerError({ field: ERROR_CODE_FIELD[code] ?? null, message: msg });
      toast.error(msg);
    } catch (e) {
      // PR-review fix 2026-05-20 SF-M2 — log network failures so CSP /
      // CORS / offline are distinguishable in browser console; toast
      // copy stays generic for the member.
       
      console.error(
        { err: String(e) },
        'broadcasts.submit.network_failed',
      );
      toast.error(
        e instanceof Error ? e.message : tErr('internal_error'),
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function onSaveDraft() {
    if (submitting) return;
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        subject,
        bodyHtml,
        bodySource: bodyHtml,
        segmentType: segment.kind,
        segmentParams: segment.kind === 'tier' ? { tierCodes: segment.tierCodes } : null,
        customRecipientEmails: segment.kind === 'custom' ? customLines : null,
        scheduledFor,
      };
      const method = initialDraftId !== null ? 'PUT' : 'POST';
      if (initialDraftId !== null) body['draftId'] = initialDraftId;

      const res = await fetch('/api/broadcasts/draft', {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const respBody = (await res.json().catch(() => ({}))) as {
          error?: { code?: string };
        };
        const code = respBody.error?.code ?? 'internal_error';
        let msg: string;
        try {
          msg = tErr(code);
        } catch {
          msg = tErr('internal_error');
        }
        toast.error(msg);
        return;
      }
      toast.success(t('toast.drafted'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-w-0 space-y-6">
      <QuotaDisplay refreshKey={quotaRefreshKey} initial={initialQuota} />
      <Card>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="broadcast-subject">{t('fields.subject')}</Label>
            <Input
              ref={subjectRef}
              id="broadcast-subject"
              value={subject}
              onChange={(e) => {
                setSubject(e.target.value);
                if (serverError?.field === 'subject') setServerError(null);
              }}
              placeholder={t('fields.subjectPlaceholder')}
              maxLength={200}
              disabled={submitting}
              aria-describedby={
                serverError?.field === 'subject'
                  ? 'broadcast-subject-error broadcast-subject-counter'
                  : 'broadcast-subject-counter'
              }
              aria-invalid={
                subjectInvalid || serverError?.field === 'subject' || undefined
              }
            />
            {serverError?.field === 'subject' ? (
              <p
                id="broadcast-subject-error"
                role="alert"
                className="text-xs text-destructive"
              >
                {serverError.message}
              </p>
            ) : null}
            <p
              id="broadcast-subject-counter"
              className="text-xs text-muted-foreground"
              aria-live="off"
            >
              {t('fields.subjectCounter', {
                count: subject.length,
                max: 200,
              })}
            </p>
          </div>

          <SegmentPicker
            value={segment}
            onChange={setSegment}
            disabled={submitting}
          />

          {/* UX-1 — surface expectations about recipient counts so the
              member doesn't hit the 5,000 cap or empty-segment-block as
              a "submit-to-discover" surprise. We deliberately don't
              compute the live count here (would require an auth'd API
              endpoint + debounced fetch + cap pre-check) — instead
              describe the segment shape + link to broadcast detail
              page where the post-submit count is visible. */}
          <p className="text-xs text-muted-foreground">
            {segment.kind === 'all_members'
              ? t('estimateNote.allMembers')
              : segment.kind === 'tier'
                ? t('estimateNote.tier')
                : t('estimateNote.custom')}
          </p>

          {segment.kind === 'custom' ? (
            <CustomListInput
              value={customList}
              onChange={setCustomList}
              disabled={submitting}
            />
          ) : null}

          {segment.kind === 'custom' && customLines.length > 0 ? (
            <p
              className="text-xs text-muted-foreground"
              aria-live="polite"
            >
              {t('estimateNote.customCount', { count: customLines.length })}
            </p>
          ) : null}

          <div
            ref={bodyContainerRef}
            tabIndex={-1}
            className="space-y-2 outline-none"
            aria-invalid={bodyInvalid || serverError?.field === 'body' || undefined}
            // QA T191 fix (2026-05-03) — WCAG 3.3.1: SR users hearing
            // `aria-invalid` need the error reason programmatically
            // associated. The error <p> below carries id="broadcast-
            // body-error"; this `aria-describedby` wires the chain.
            // Note: ideally the inner Tiptap `contenteditable` would
            // also receive the describedby via `editorProps.attributes`
            // but that requires a TiptapEditor prop addition; the
            // wrapper-div-level association is what most SR pipelines
            // resolve to anyway when `aria-invalid` is on the wrapper.
            aria-describedby={
              bodyInvalid || serverError?.field === 'body'
                ? 'broadcast-body-error'
                : undefined
            }
          >
            <Label id="broadcast-body-label">{t('fields.bodyLabel')}</Label>
            <TiptapEditor
              initialHtml={initialBodyHtml}
              onChange={(next) => {
                setBodyHtml(next);
                if (serverError?.field === 'body') setServerError(null);
                // PR-review fix 2026-05-20 UX-C1 — clear disallowed-
                // sources list when the user edits the body (they may
                // be acting on the listed offenders).
                if (unsafeImageSources !== null) setUnsafeImageSources(null);
              }}
              disabled={submitting}
              labelledById="broadcast-body-label"
              imagesEnabled={imagesEnabled}
              draftId={initialDraftId}
            />
            {/* PR-review fix 2026-05-20 UX-C1 — accumulated disallowed
                image sources list. role=alert so SR users hear it
                immediately on submit. */}
            {unsafeImageSources !== null && unsafeImageSources.length > 0 ? (
              <UnsafeImageSourcesList urls={unsafeImageSources} />
            ) : null}
            {serverError?.field === 'body' ? (
              <p
                id="broadcast-body-error"
                className="text-xs text-destructive"
                role="alert"
              >
                {serverError.message}
              </p>
            ) : bodyInvalid ? (
              <p
                id="broadcast-body-error"
                className="text-xs text-destructive"
                role="alert"
              >
                {tErr('broadcast_body_too_large')}
              </p>
            ) : null}
          </div>

          <SchedulePicker
            value={scheduledFor}
            onChange={setScheduledFor}
            disabled={submitting}
          />

          <PreviewPane subject={subject} bodyHtml={deferredBody} />

          {/* UX-4 — surface FR-004a cancellation cutoff so members know
              they can still pull back a submission until admin approves. */}
          <p className="text-xs text-muted-foreground">
            {t('submitNote.cancellable')}
          </p>

          <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              onClick={onSaveDraft}
              disabled={submitting}
            >
              {t('button.saveDraft')}
            </Button>
            <SubmitButton
              disabled={submitDisabled}
              submitting={submitting}
              onClick={onSubmit}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
