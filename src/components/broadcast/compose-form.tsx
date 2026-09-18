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
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { Loader2Icon } from 'lucide-react';
import { toast } from 'sonner';
import {
  errorValues,
  estimateNoteKey,
  excludedByPreference,
  PREFERENCE_TOAST_DURATION_MS,
  selfExclusionHintKey,
  submitBlockedByCount,
  type ComposeAudienceMode,
} from '@/components/broadcast/submit-feedback';
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
import { RecipientCountLine, useRecipientCount } from './recipient-count';
import { composeHasContent } from './compose/compose-content';
import { SubjectCounter } from './compose/subject-counter';
import {
  ComposeTemplatePickerField,
  type ComposeTemplateOption,
} from './compose/template-picker-field';
import { useComposeDirtyGuard } from './compose/use-compose-dirty-guard';

const TiptapEditor = loadTiptapEditor<{
  initialHtml: string;
  onChange: (html: string) => void;
  disabled?: boolean;
  labelledById?: string;
  // F119 T144 (FR-048) — the error belongs on the `contenteditable`, not on a
  // wrapper div the user never focuses.
  describedById?: string;
  invalid?: boolean;
  imagesEnabled?: boolean;
  draftId?: string | null;
}>(() => import('./tiptap-editor'));

/** What an untouched Tiptap document serialises to. */
const EMPTY_BODY_HTML = '<p></p>';
const BODY_ERROR_ID = 'broadcast-body-error';

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
export function buildSegmentPayload(
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
  /**
   * 108 PR-C T079 / T085 — the ceiling and the audience leg in force,
   * resolved server-side by the page from the composition root
   * (`currentAudienceCeiling()` / `currentAudienceMode()`), so the copy
   * names the real limit (FR-041) and says who the recipients are under the
   * flag (FR-020). REQUIRED on purpose: a default here would be a second
   * definition of the ceiling (FR-042).
   */
  readonly audienceCeiling: number;
  readonly audienceMode: ComposeAudienceMode;
  /**
   * F119 T140 (FR-046) — the tenant's templates WITH their content, resolved
   * server-side (chamber-name substitution already applied). The picker lives
   * inside the form now so a choice re-seeds state in place instead of
   * remounting the form through a URL push.
   */
  readonly templates?: readonly ComposeTemplateOption[];
  /** The template the page pre-populated from (`?template=`), if any. */
  readonly initialTemplateId?: string | null;
}

export function ComposeForm({
  initialDraftId = null,
  initialSubject = '',
  initialBodyHtml = EMPTY_BODY_HTML,
  initialQuota = null,
  imagesEnabled = false,
  audienceCeiling,
  audienceMode,
  templates = [],
  initialTemplateId = null,
}: ComposeFormProps): React.ReactElement {
  const router = useRouter();
  const t = useTranslations('portal.broadcasts.compose');
  const tErr = useTranslations('portal.broadcasts.compose.errors');
  const format = useFormatter();
  // The preview is rendered server-side in the member's own UI language.
  const locale = useLocale();

  const [subject, setSubject] = useState<string>(initialSubject);
  const [bodyHtml, setBodyHtml] = useState<string>(initialBodyHtml);
  // E2E + UX bug fix 2026-05-21: track the draft id locally so the
  // Tiptap editor's `draftId` prop is the AUTHORITATIVE source for
  // whether the inline-image uploader renders (gated behind
  // `draftId !== null`). Initialised from the server prop; updated
  // when `Save as draft` POST returns a new broadcastId.
  const [currentDraftId, setCurrentDraftId] = useState<string | null>(
    initialDraftId,
  );
  const [segment, setSegment] = useState<SegmentPickerValue>({
    kind: 'all_members',
    tierCodes: [],
  });
  const [customList, setCustomList] = useState<string>('');
  const [scheduledFor, setScheduledFor] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  // F119 T143 — its own flag so the save control can show a busy state that a
  // submit-in-flight would otherwise claim.
  const [savingDraft, setSavingDraft] = useState<boolean>(false);
  const [quotaRefreshKey, setQuotaRefreshKey] = useState<number>(0);
  // F119 T140 — which template is applied, and the html the editor is seeded
  // with. Tiptap reads `initialHtml` once per mount, so applying a template
  // bumps `nonce`, remounting the EDITOR alone — never the form.
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(
    initialTemplateId,
  );
  const [editorSeed, setEditorSeed] = useState<{
    readonly html: string;
    readonly nonce: number;
  }>({ html: initialBodyHtml, nonce: 0 });
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
  // 108 PR-C T089 — debounced live count for the chosen segment (member mode:
  // the caller's own member is the one self-excluded server-side).
  // Round 2 (UX H-5): a "Try again" on an unavailable count re-runs the
  // same segment; the nonce is the only thing that changes.
  const [countRetry, setCountRetry] = useState(0);
  const recipientCount = useRecipientCount(
    {
      mode: 'member',
      segment: { kind: segment.kind, tierCodes: segment.tierCodes },
    },
    countRetry,
  );

  // UX-3 — beforeunload guard so a member who composed substantial content +
  // accidentally closes the tab gets a browser-native "Are you sure you want
  // to leave?" prompt.
  //
  // F119 T143 (FR-045): the comparison baseline is the last SAVED snapshot,
  // not the immutable `initialSubject` / `initialBodyHtml` props. With the old
  // baseline a member who saved a draft and changed nothing since was still
  // warned — which teaches people to dismiss the warning that matters.
  const dirtyGuard = useComposeDirtyGuard(
    { subject, bodyHtml },
    {
      initial: { subject: initialSubject, bodyHtml: initialBodyHtml },
      suspended: submitting,
    },
  );

  // UX-R2-1 — auto-focus the failing field when a server error arrives.
  useEffect(() => {
    if (serverError === null) return;
    if (serverError.field === 'subject') subjectRef.current?.focus();
    else if (serverError.field === 'body') bodyContainerRef.current?.focus();
    // segment / customList are radio/textarea — toast suffices
  }, [serverError]);

  const customLines = parseLines(customList);
  // /code-review 2026-09-07 (finding #6) — both are null for a segment
  // kind this build does not recognise; the JSX omits the line rather
  // than rendering a raw i18n key path (next-intl does not throw).
  const estimateNote = estimateNoteKey(segment.kind, audienceMode);
  const selfExclusionHint = selfExclusionHintKey(segment.kind);
  const validation = SubmitSchema.safeParse({ subject, bodyHtml });
  const customListValid =
    segment.kind !== 'custom' || (customLines.length > 0 && customLines.length <= 100);
  const tierValid = segment.kind !== 'tier' || segment.tierCodes.length > 0;
  // Round 2 (UX H-4, decision (a)): a MEASURED refusal from the live count
  // blocks the submit — the count line, in red, is the reason. `unavailable`
  // never blocks (the server recomputes — FR-040b).
  const submitDisabled =
    !validation.success || !customListValid || !tierValid || submitBlockedByCount(recipientCount);

  // UX-C2 — per-field error tracking for aria-describedby + aria-invalid.
  // Empty subject/body is the "needs input" state, not an "error" state
  // (don't shout red at users who haven't typed yet); only mark invalid
  // when the user has typed something AND it fails.
  const subjectInvalid = subject.length > 0 && subject.length > 200;
  const bodyInvalid = bodyHtml.length > 200 * 1024;
  // F119 T144 (FR-048) — one derivation, handed to the editor as `invalid` +
  // `describedById` so assistive tech announces the reason ON the control.
  const bodyHasError = bodyInvalid || serverError?.field === 'body';

  /**
   * F119 T140 (FR-046) — re-seed in place. The subject and the body are
   * replaced; the segment, the custom list, the schedule and any draft id
   * already minted are deliberately left alone, because a template says
   * nothing about who the message goes to or when.
   */
  function applyTemplate(option: ComposeTemplateOption | null): void {
    const nextBody = option?.bodyHtml ?? EMPTY_BODY_HTML;
    setSubject(option?.subject ?? '');
    setBodyHtml(nextBody);
    setEditorSeed((prev) => ({ html: nextBody, nonce: prev.nonce + 1 }));
    setSelectedTemplateId(option?.id ?? null);
    setServerError(null);
    setUnsafeImageSources(null);
  }

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
      if (currentDraftId !== null) body['draftId'] = currentDraftId;

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
          // 108 PR-C T085: `cap` / `count` ride on the audience-too-large 422
          // so the copy can name the ceiling the server refused against.
          details?: { disallowedSources?: ReadonlyArray<string>; cap?: unknown; count?: unknown };
        };
        broadcastId?: string;
        // 108 PR-C (FR-022a) — how many entries the resolver excluded by
        // recipient preference; shown as a number in the success toast.
        recipientPreferenceExcluded?: unknown;
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
        toast.success(t('toast.submitted'), { description: t('toast.submittedSlaHint') });
        // 108 PR-C T077 (FR-022a): "{n} addresses were excluded by recipient
        // preference." Round 2 (UX H-6): its OWN toast, held longer — as a
        // description under the success toast it vanished in 4 s while
        // `router.push()` was already navigating away.
        const excluded = excludedByPreference(responseBody);
        if (excluded > 0) {
          toast.info(t('toast.preferenceExcluded', { count: excluded }), {
            duration: PREFERENCE_TOAST_DURATION_MS,
          });
        }
        setQuotaRefreshKey((n) => n + 1);
        router.push(`/portal/benefits?tab=broadcasts&submitted=${responseBody.broadcastId}`);
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
      // 108 PR-C T085: the too-large copy interpolates the ceiling from the
      // 422 body, falling back to the page's own ceiling (round 2, i18n H4 —
      // next-intl never throws; a missing value would have rendered the raw
      // key path, so the `try/catch` that used to sit here was dead code).
      const msg = tErr(code, errorValues(code, responseBody.error?.details, audienceCeiling));
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
    if (submitting || savingDraft) return;
    setSavingDraft(true);
    setSubmitting(true);
    // Captured BEFORE the round trip: this is what the server is being asked
    // to store, so it — not whatever the member typed while it was in flight —
    // is the snapshot the dirty guard must compare against afterwards.
    const savedSnapshot = { subject, bodyHtml };
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
      const method = currentDraftId !== null ? 'PUT' : 'POST';
      if (currentDraftId !== null) body['draftId'] = currentDraftId;

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
      // E2E + UX bug fix 2026-05-21: when the FIRST `Save as draft` POST
      // creates a new draft, the API returns `{ broadcastId }` but the
      // component previously dropped the id on the floor — `currentDraftId`
      // stayed `null`, so the Tiptap editor's inline-image uploader
      // remained hidden (gated behind `draftId !== null`). Real-world
      // symptom: member saves draft, expects to upload an image, sees
      // only the "Save draft first" hint indefinitely. Fix: capture the
      // new broadcastId from the response + update local `currentDraftId`
      // state so the TiptapEditor re-renders with the new draftId prop
      // (which renders the inline-image uploader instead of the hint).
      // The compose page (server component) does not yet support
      // `?draftId=` resume — that is F7.1b scope — so we manage the
      // draft-id transition entirely in client state.
      const respBody = (await res.json().catch(() => null)) as {
        broadcastId?: string;
      } | null;
      if (currentDraftId === null && respBody?.broadcastId) {
        setCurrentDraftId(respBody.broadcastId);
      }
      toast.success(t('toast.drafted'));
      // F119 T143 (FR-045) — the save cleared the unsaved-changes state.
      dirtyGuard.markSaved(savedSnapshot);
    } finally {
      setSubmitting(false);
      setSavingDraft(false);
    }
  }

  return (
    <div className="min-w-0 space-y-6">
      <QuotaDisplay refreshKey={quotaRefreshKey} initial={initialQuota} />
      {/* F119 T140 (FR-046) — inside the form, so a choice re-seeds state
          instead of navigating and remounting it. */}
      <ComposeTemplatePickerField
        templates={templates}
        selectedId={selectedTemplateId}
        hasContent={composeHasContent(subject, bodyHtml)}
        onApply={applyTemplate}
        disabled={submitting}
      />
      {/* F119 T148 (FR-050) — the editor and the 600 px email preview sit side
          by side from `lg` up and stack below it; the page supplies the 72 rem
          container the pair needs (exception recorded in ux-standards § 18.2). */}
      <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,600px)]">
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
              <SubjectCounter id="broadcast-subject-counter" value={subject} />
            </div>

            <SegmentPicker
              value={segment}
              onChange={setSegment}
              disabled={submitting}
            />

            {/* UX-1 — set expectations before the live count settles: the
                estimate note describes the segment shape and the REAL
                ceiling (`audienceCeiling`, not a hard-coded 5,000), and
                `RecipientCountLine` below shows the resolver's own number
                once it lands (108 PR-C T089 — the auth'd endpoint, the
                debounced fetch and the cap pre-check this comment once said
                were deliberately not built). */}
            {/* 108 PR-C T079: leg-aware wording + the real ceiling (FR-041).
                /code-review finding #6: an unrecognised segment kind yields
                null and this line is omitted — never a raw i18n key path,
                which is what next-intl renders for an unknown key. */}
            {estimateNote !== null ? (
              <p className="text-xs text-muted-foreground">
                {t(estimateNote, { ceiling: audienceCeiling })}
              </p>
            ) : null}
            {/* 108 PR-C T079 (FR-022b): self-exclusion covers every contact of
                the sending member, not only the primary address. Round 2 (UX
                H-3): every segment kind says which way the rule goes — silence
                on the custom list / attendees read as "same rule". */}
            {selfExclusionHint !== null ? (
              <p className="text-xs text-muted-foreground">{t(selfExclusionHint)}</p>
            ) : null}
            {/* 108 PR-C T089 (FR-040): the live count — the same resolver that
                decides the send, so the number shown is the number sent (SC-004). */}
            <RecipientCountLine state={recipientCount} onRetry={() => setCountRetry((n) => n + 1)} />

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

            {/* F119 T144 (FR-048): `aria-invalid` + `aria-describedby` used to
                live on THIS wrapper. It is not the control anyone focuses — the
                Tiptap `contenteditable` is — so the reason was announced on an
                element the user never lands on. Both now travel into the editor
                as props (`tiptap-editor.tsx:106,113`), the way
                `admin/template-form.tsx:283-286` already did it. The div keeps
                `tabIndex={-1}` only so a server error can move focus here. */}
            <div
              ref={bodyContainerRef}
              tabIndex={-1}
              className="space-y-2 outline-none"
            >
              <Label id="broadcast-body-label">{t('fields.bodyLabel')}</Label>
              <TiptapEditor
                key={editorSeed.nonce}
                initialHtml={editorSeed.html}
                invalid={bodyHasError}
                {...(bodyHasError ? { describedById: BODY_ERROR_ID } : {})}
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
                draftId={currentDraftId}
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

            {/* UX-4 — surface FR-004a cancellation cutoff so members know
                they can still pull back a submission until admin approves. */}
            <p className="text-xs text-muted-foreground">
              {t('submitNote.cancellable')}
            </p>

            <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-end">
              {/* F119 T143 (FR-045) — the receipt for the save, in the member's
                  own locale via next-intl's formatter (never hand-formatted). */}
              {dirtyGuard.savedAt !== null ? (
                <p
                  data-testid="compose-saved-at"
                  className="text-xs text-muted-foreground sm:mr-auto"
                  aria-live="polite"
                >
                  {t('savedAt', {
                    time: format.dateTime(dirtyGuard.savedAt, {
                      hour: '2-digit',
                      minute: '2-digit',
                    }),
                  })}
                </p>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                onClick={onSaveDraft}
                disabled={submitting}
                aria-busy={savingDraft || undefined}
              >
                {savingDraft ? (
                  <Loader2Icon
                    className="size-4 motion-safe:animate-spin"
                    aria-hidden="true"
                  />
                ) : null}
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

        <div className="min-w-0 lg:sticky lg:top-4">
          <PreviewPane
            subject={subject}
            bodyHtml={deferredBody}
            endpoint="/api/broadcasts/preview"
            locale={locale}
          />
        </div>
      </div>
    </div>
  );
}
