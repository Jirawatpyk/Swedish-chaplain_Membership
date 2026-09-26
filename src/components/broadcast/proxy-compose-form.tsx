'use client';

/**
 * DV-4 — Admin proxy-compose form.
 *
 * A thin admin-only orchestrator that reuses the member-facing compose
 * sub-components (segment-picker, custom-list-input, schedule-picker,
 * preview-pane, submit-button, Tiptap body editor) to submit a broadcast
 * on a member's behalf via the existing `/api/admin/broadcasts/proxy-submit`
 * route (Q12 admin-on-behalf-of-member).
 *
 * Differences from the member `ComposeForm`:
 *   - Adds a `MemberPicker` for selecting the proxied member (DV-4 Task 4).
 *   - Self-exclusion notice (Q16) once a member is picked: the proxied
 *     member never receives their own e-blast.
 *
 * F119 T145 (US6-AS5, FR-039) — "the writing tool MUST be the same" for a
 * member writing an original and for staff composing on their behalf. This
 * form now shares the member form's template picker, subject counter,
 * unsaved-changes guard, preview and editor-level error association, by
 * REUSING those pieces (`compose/*`) rather than forking them.
 *
 * The last three parity items landed with the two thin staff routes T145 added
 * (contract § `POST | PUT /api/admin/broadcasts/draft` and
 * § `GET /api/admin/broadcasts/quota`), both of which reuse the use cases the
 * member routes already call:
 *   - draft save/resume against `/api/admin/broadcasts/draft` through the
 *     SHARED `saveComposeDraft` helper, clearing the unsaved-changes guard and
 *     showing the same "Saved at" receipt (FR-045);
 *   - inline images: the saved draft id + `imagesEnabled` go into the SAME
 *     Tiptap editor and the SAME uploader, pointed at
 *     `POST /api/admin/broadcasts/[id]/images` (FR-040);
 *   - the proxied member's allowance via the SAME `QuotaDisplay`, pointed at
 *     the staff quota route for the picked member — nothing is rendered before
 *     a member is picked, because there is no allowance to show yet.
 *
 * Error mapping (`ERROR_HANDLING`) reacts to `json.error.code` from the
 * route's bilingual envelope (`broadcasts-route-helpers.ts`):
 *   - broadcast_member_not_found → inline picker error + refocus picker
 *   - broadcast_quota_blocked / broadcast_not_in_plan → toast with {company}
 *   - field codes → inline field error (subject/body/segment)
 *   - everything else (halt, rate-limit, missing-contact, internal) → generic toast
 */

import { useDeferredValue, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2Icon } from 'lucide-react';
import { toast } from '@/lib/toast';
import {
  errorValues,
  excludedByPreference,
  PREFERENCE_TOAST_DURATION_MS,
  proxySelfExclusionNoticeKey,
  submitBlockedByCount,
  submitBlockedHintKey,
} from '@/components/broadcast/submit-feedback';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { UnsavedChangesGuard } from '@/components/shell/unsaved-changes-guard';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { loadTiptapEditor } from '@/components/ui/tiptap-loader';
import { MemberPicker, type MemberPickerOption } from './member-picker';
import {
  SegmentPicker,
  type SegmentPickerValue,
} from './segment-picker';
import { CustomListInput, parseLines } from './custom-list-input';
import { SchedulePicker } from './schedule-picker';
import { PreviewPane } from './preview-pane';
import { QuotaDisplay } from './quota-display';
import { SubmitButton } from './submit-button';
import { buildSegmentPayload } from './compose-form';
import { RecipientCountLine, useRecipientCount } from './recipient-count';
import { composeHasContent } from './compose/compose-content';
import { SubjectCounter } from './compose/subject-counter';
import {
  ComposeTemplatePickerField,
  type ComposeTemplateOption,
} from './compose/template-picker-field';
import { useComposeDirtyGuard } from './compose/use-compose-dirty-guard';
import { saveComposeDraft } from './compose/save-compose-draft';
import { formatLocalisedDate, TIME_HH_MM } from '@/lib/format-date-localised';

// F119 T145 — the SAME loader and the SAME editor the member compose form
// uses, now with the same `imagesEnabled` / `draftId` props too: the staff
// draft route mints the id, and `imageUploadUrl` points the one shared
// uploader at the staff endpoint (FR-039/FR-040).
const TiptapEditor = loadTiptapEditor<{
  initialHtml: string;
  onChange: (html: string) => void;
  disabled?: boolean;
  labelledById?: string;
  // F119 T144 (FR-048) — the error belongs on the `contenteditable`.
  describedById?: string;
  invalid?: boolean;
  imagesEnabled?: boolean;
  draftId?: string | null;
  imageUploadUrl?: string;
}>(() => import('./tiptap-editor'));

const ADMIN_DRAFT_ENDPOINT = '/api/admin/broadcasts/draft';

const INITIAL_BODY_HTML = '<p></p>';
const BODY_ERROR_ID = 'proxy-broadcast-body-error';
/** U29 — the elements a dimmed Submit points at, plus its own hint line. */
const MISSING_EMAIL_ID = 'proxy-missing-contact-email';
const RECIPIENT_COUNT_TEXT_ID = 'proxy-recipient-count';
const SUBMIT_BLOCKED_HINT_ID = 'proxy-submit-blocked';

const SubmitSchema = z.object({
  subject: z.string().min(1).max(200),
  bodyHtml: z.string().min(1).max(200 * 1024),
});

/**
 * Field-level server error target. `null` for form-level errors handled
 * by toast. Mirrors `compose-form.tsx`'s `ServerErrorField`.
 */
type ServerErrorField = 'subject' | 'body' | 'segment' | 'customList' | null;

/**
 * Map a route error code → how the proxy form reacts. Field codes set an
 * inline error; `picker` refocuses the member combobox; `toast` shows a
 * sonner toast keyed to a `{company}`-interpolated message.
 *
 * UX-review fix (DV-4) — WCAG 3.3.1/3.3.3: each field/segment code now
 * carries a SPECIFIC message key (mirrors the member compose-form's
 * `ERROR_CODE_FIELD` → per-code copy) instead of the generic
 * `submitErrorToast`, so SR users hear WHICH field failed and WHY.
 */
type ProxyErrorHandling =
  | { readonly kind: 'picker' }
  | { readonly kind: 'pickerError'; readonly key: 'missingContactEmailError' }
  | {
      readonly kind: 'field';
      readonly field: 'subject' | 'body' | 'segment';
      readonly key:
        | 'subjectEmptyError'
        | 'subjectTooLongError'
        | 'bodyTooLargeError'
        | 'bodyUnsafeHtmlError'
        | 'emptySegmentError'
        | 'audienceTooLargeError';
    }
  | {
      // Portal live walk U28 (FR-039) — the custom-list refusals read in the
      // member form's own words (`portal.broadcasts.compose.errors.*`).
      readonly kind: 'customList';
      readonly key:
        | 'errors.broadcast_custom_recipient_invalid_format'
        | 'errors.broadcast_custom_recipient_too_many';
    }
  | {
      readonly kind: 'toast';
      readonly key: 'quotaBlockedError' | 'notInPlanError';
    };

const ERROR_HANDLING: Record<string, ProxyErrorHandling> = {
  broadcast_member_not_found: { kind: 'picker' },
  // Defense-in-depth: the form blocks submit when hasPrimaryContactEmail===false,
  // but if the server still 422s (e.g. stale picker data), surface a clear
  // picker-level message rather than the generic toast.
  broadcast_member_missing_primary_contact_email: {
    kind: 'pickerError',
    key: 'missingContactEmailError',
  },
  broadcast_quota_blocked: { kind: 'toast', key: 'quotaBlockedError' },
  broadcast_not_in_plan: { kind: 'toast', key: 'notInPlanError' },
  // Portal live walk U28 — `/api/admin/broadcasts/draft` answers this code
  // since the classifier landed, so the staff form puts it on the field the
  // member form does rather than falling to the generic save-failed toast.
  broadcast_subject_empty: {
    kind: 'field',
    field: 'subject',
    key: 'subjectEmptyError',
  },
  broadcast_subject_too_long: {
    kind: 'field',
    field: 'subject',
    key: 'subjectTooLongError',
  },
  broadcast_body_too_large: {
    kind: 'field',
    field: 'body',
    key: 'bodyTooLargeError',
  },
  broadcast_body_unsafe_html: {
    kind: 'field',
    field: 'body',
    key: 'bodyUnsafeHtmlError',
  },
  broadcast_empty_segment_blocked: {
    kind: 'field',
    field: 'segment',
    key: 'emptySegmentError',
  },
  broadcast_audience_too_large: {
    kind: 'field',
    field: 'segment',
    key: 'audienceTooLargeError',
  },
  // U28 — both draft routes refuse the custom list with these codes, so a
  // refused draft save names the list rather than "couldn't save the draft".
  broadcast_custom_recipient_invalid_format: {
    kind: 'customList',
    key: 'errors.broadcast_custom_recipient_invalid_format',
  },
  broadcast_custom_recipient_too_many: {
    kind: 'customList',
    key: 'errors.broadcast_custom_recipient_too_many',
  },
};

export interface ProxyComposeFormProps {
  /**
   * Round 2 (i18n H4) — the ceiling the page resolved server-side; the
   * fallback for the too-large error copy when the 422 body carries no cap.
   */
  readonly audienceCeiling: number;
  /**
   * F119 T145 (FR-039) — the same template options the member compose form
   * gets, resolved server-side with chamber-name substitution applied.
   */
  readonly templates?: readonly ComposeTemplateOption[];
  /**
   * F119 T145 (FR-039/FR-040) — the F7.1a US2 image kill-switch, resolved
   * server-side exactly as the member compose page resolves it. Images still
   * need a saved draft to own them, so the editor shows the member form's
   * "save the draft first" hint until one exists.
   */
  readonly imagesEnabled?: boolean;
}

export function ProxyComposeForm({
  audienceCeiling,
  templates = [],
  imagesEnabled = false,
}: ProxyComposeFormProps): React.ReactElement {
  const t = useTranslations('admin.broadcasts.proxySubmitDialog');
  // U29 / FR-039 — the shared compose copy this form already renders through
  // `SubjectCounter`, `SegmentPicker` and `SubmitButton`; the blocked-reason
  // line must read the same on both surfaces, so it comes from the same keys.
  const tCompose = useTranslations('portal.broadcasts.compose');
  // The proxySubmitDialog namespace has no member-search loading string;
  // reuse the canonical members-picker loading copy ("Loading members…")
  // rather than hardcoding a new string.
  const tLink = useTranslations('admin.users.invite.linkMember');
  // The preview is rendered server-side in the staff user's own UI language.
  const locale = useLocale();
  // F119 T145 (FR-045) — the "Saved at" receipt, formatted by next-intl in the
  // staff user's locale, never by hand.
  const router = useRouter();

  const pickerRef = useRef<HTMLButtonElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyContainerRef = useRef<HTMLDivElement>(null);

  const [member, setMember] = useState<MemberPickerOption | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [bodyHtml, setBodyHtml] = useState(INITIAL_BODY_HTML);
  const [segment, setSegment] = useState<SegmentPickerValue>({
    kind: 'all_members',
    tierCodes: [],
  });
  const [customList, setCustomList] = useState('');
  const [scheduledFor, setScheduledFor] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // F119 T145 — the staff-owned draft. `null` until the first save; captured
  // from the 201 so the inline-image uploader stops being hidden (the same
  // trap the member form fell into on 2026-05-21). Picking a DIFFERENT member
  // drops it: the draft belongs to the member it was created for, and a PUT
  // naming another member is refused by `saveDraft`'s ownership guard.
  const [currentDraftId, setCurrentDraftId] = useState<string | null>(null);
  const [savingDraft, setSavingDraft] = useState(false);
  const [fieldError, setFieldError] = useState<{
    field: ServerErrorField;
    message: string;
  } | null>(null);
  // F119 T145 — template state, mirroring the member form: Tiptap reads
  // `initialHtml` once per mount, so applying a template bumps `nonce` and
  // remounts the EDITOR alone, never the form.
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(
    null,
  );
  const [editorSeed, setEditorSeed] = useState<{
    readonly html: string;
    readonly nonce: number;
  }>({ html: INITIAL_BODY_HTML, nonce: 0 });

  // F119 T145 (FR-039/FR-045) — the unsaved-changes guard the member form has,
  // now against the LAST SAVED snapshot on this side too: a staff draft save
  // calls `markSaved`, so saving and leaving is silent while typing and
  // leaving still warns.
  const dirtyGuard = useComposeDirtyGuard(
    { subject, bodyHtml },
    {
      initial: { subject: '', bodyHtml: INITIAL_BODY_HTML },
      suspended: submitting,
    },
  );

  const deferredBody = useDeferredValue(bodyHtml);
  const customLines = parseLines(customList);
  // null for a segment kind this build does not recognise — the notice is
  // then omitted rather than promising the opposite (/code-review, the
  // pass after #6).
  const proxySelfExclusionNotice = proxySelfExclusionNoticeKey(segment.kind);
  // 108 PR-C T089 — live count for the PROXIED member (its contacts are the
  // ones self-excluded server-side); idle until a member is picked.
  const [countRetry, setCountRetry] = useState(0);
  const recipientCount = useRecipientCount(
    {
      mode: 'admin',
      memberId: member?.memberId ?? null,
      segment: { kind: segment.kind, tierCodes: segment.tierCodes },
    },
    countRetry,
  );

  // Submit precondition: member picked + subject/body valid + segment
  // shape valid (custom needs 1–100 entries; tier needs ≥1 code). Mirrors
  // compose-form.tsx's derivation.
  const validation = SubmitSchema.safeParse({ subject, bodyHtml });
  const customListValid =
    segment.kind !== 'custom' ||
    (customLines.length > 0 && customLines.length <= 100);
  const tierValid = segment.kind !== 'tier' || segment.tierCodes.length > 0;
  // Disable submit when the picked member has no primary contact email — the
  // server would 422 with broadcast_member_missing_primary_contact_email anyway;
  // blocking early lets the admin know immediately and avoids a wasted round trip.
  const memberMissingEmail =
    member !== null && member.hasPrimaryContactEmail === false;
  // Round 2 (UX H-4): a measured refusal from the live count blocks here too.
  const countBlocked = submitBlockedByCount(recipientCount);
  const submitDisabled =
    member === null ||
    memberMissingEmail ||
    !validation.success ||
    !customListValid ||
    !tierValid ||
    countBlocked;

  // U29 — the member form marks an over-size body locally; this one only ever
  // showed the SERVER's refusal, so a paste over the limit dimmed Submit with
  // nothing said anywhere. Same derivation, same copy.
  const bodyInvalid = bodyHtml.length > 200 * 1024;
  const bodyHasError = bodyInvalid || fieldError?.field === 'body';

  /**
   * U29 (WCAG 3.3.2) — why Submit is dimmed, in the member form's own words
   * wherever the reason is shared (FR-039: the same writing tool). The two
   * staff-only reasons come first because they gate everything else: no member
   * picked, and a picked member with no primary contact email — the latter
   * already has its own visible warning, so it is associated rather than
   * repeated.
   */
  function blockedReasonText(): string | null {
    if (member === null) return t('memberRequiredHint');
    if (memberMissingEmail) return null;
    const key = submitBlockedHintKey({
      subjectEmpty: subject.length === 0,
      subjectTooLong: subject.length > 200,
      tierValid,
      customListValid,
      customLineCount: customLines.length,
    });
    return key === null ? null : tCompose(key);
  }
  const blockedReasonMessage = blockedReasonText();
  const submitBlockedReasonIds = [
    ...(blockedReasonMessage !== null ? [SUBMIT_BLOCKED_HINT_ID] : []),
    ...(memberMissingEmail ? [MISSING_EMAIL_ID] : []),
    ...(bodyInvalid ? [BODY_ERROR_ID] : []),
    ...(countBlocked ? [RECIPIENT_COUNT_TEXT_ID] : []),
  ].join(' ');

  /**
   * F119 T140/T145 (FR-046) — re-seed in place; the picked member, the
   * segment and the schedule are deliberately untouched.
   */
  function applyTemplate(option: ComposeTemplateOption | null): void {
    const nextBody = option?.bodyHtml ?? INITIAL_BODY_HTML;
    setSubject(option?.subject ?? '');
    setBodyHtml(nextBody);
    setEditorSeed((prev) => ({ html: nextBody, nonce: prev.nonce + 1 }));
    setSelectedTemplateId(option?.id ?? null);
    setFieldError(null);
  }

  // Auto-focus the failing field when a field-level server error arrives.
  useEffect(() => {
    if (fieldError === null) return;
    if (fieldError.field === 'subject') subjectRef.current?.focus();
    else if (fieldError.field === 'body') bodyContainerRef.current?.focus();
    // segment is a radio group — the inline error + toast suffices.
  }, [fieldError]);

  function handleErrorCode(
    code: string,
    companyName: string,
    // 108 PR-C T085 — the 422 `details` (`cap` / `count` on the
    // audience-too-large refusal) so the copy names the real ceiling.
    details?: Record<string, unknown>,
  ): void {
    const handling = ERROR_HANDLING[code] ?? null;
    if (handling === null) {
      // Unmapped: halt, rate-limit, missing-primary-contact, internal,
      // invalid_body, etc. → generic toast.
      toast.error(t('submitErrorToast'));
      return;
    }
    switch (handling.kind) {
      case 'picker':
        // Clear the stale selection: the picked member no longer exists, so
        // the trigger must drop its company name, the self-exclusion notice
        // must disappear, and submit must re-disable (member === null) so the
        // admin can't resubmit the same dead id.
        setMember(null);
        setMemberError(t('memberNotFoundError'));
        pickerRef.current?.focus();
        break;
      case 'pickerError':
        // Server confirmed the selected member has no primary contact email.
        // Show a picker-level error and refocus; do NOT clear the selection
        // (the admin may want to navigate to the member to add a contact first).
        setMemberError(t(handling.key));
        pickerRef.current?.focus();
        break;
      case 'field': {
        const message = t(handling.key, errorValues(code, details, audienceCeiling));
        setFieldError({ field: handling.field, message });
        toast.error(message);
        break;
      }
      case 'customList': {
        // As in the member form, the textarea takes no focus — the toast
        // carries the reason, and editing the list clears it.
        const message = tCompose(handling.key);
        setFieldError({ field: 'customList', message });
        toast.error(message);
        break;
      }
      case 'toast':
        toast.error(t(handling.key, { company: companyName }));
        break;
    }
  }

  async function handleSubmit(): Promise<void> {
    if (submitting || member === null) return;
    setSubmitting(true);
    setMemberError(null);
    setFieldError(null);
    const companyName = member.companyName;
    try {
      const res = await fetch('/api/admin/broadcasts/proxy-submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          requestedByMemberId: member.memberId,
          ...(currentDraftId !== null && { draftId: currentDraftId }),
          subject,
          bodyHtml,
          bodySource: bodyHtml,
          segment: buildSegmentPayload(segment, customLines),
          scheduledFor,
        }),
      });

      if (res.ok) {
        // 108 PR-C T077 (FR-022a): the count of entries excluded by
        // recipient preference rides on the 200 body; the admin sees the
        // number, never the addresses.
        const okBody = (await res.json().catch(() => null)) as {
          recipientPreferenceExcluded?: unknown;
        } | null;
        toast.success(t('successToast', { company: companyName }));
        // Round 2 (UX H-6): its own toast, held longer.
        const excluded = excludedByPreference(okBody ?? {});
        if (excluded > 0) {
          toast.info(t('preferenceExcluded', { count: excluded }), {
            duration: PREFERENCE_TOAST_DURATION_MS,
          });
        }
        router.push('/admin/broadcasts');
        router.refresh();
        return;
      }

      const json: unknown = await res.json().catch(() => null);
      const code =
        typeof json === 'object' &&
        json !== null &&
        'error' in json &&
        typeof (json as { error?: { code?: unknown } }).error?.code === 'string'
          ? (json as { error: { code: string } }).error.code
          : 'internal_error';
      handleErrorCode(
        code,
        companyName,
        (json as { error?: { details?: Record<string, unknown> } } | null)?.error?.details,
      );
    } catch (e) {
      // Network/CORS/offline — log for local + E2E visibility; generic toast.

      console.error(
        { err: e instanceof Error ? e.message : String(e) },
        'admin.broadcasts.proxy_submit.network_failed',
      );
      toast.error(t('submitErrorToast'));
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * F119 T145 (FR-039/FR-045) — the member form's "Save as draft", against the
   * staff draft route. The round trip itself is the shared helper; only the
   * endpoint, the named member and the copy differ.
   */
  async function handleSaveDraft(): Promise<void> {
    if (submitting || savingDraft || member === null) return;
    setSavingDraft(true);
    setSubmitting(true);
    // Captured BEFORE the round trip: what the server is being asked to store
    // is what the dirty guard must compare against afterwards, not whatever
    // was typed while it was in flight.
    const savedSnapshot = { subject, bodyHtml };
    try {
      const saved = await saveComposeDraft({
        endpoint: ADMIN_DRAFT_ENDPOINT,
        draftId: currentDraftId,
        payload: {
          memberId: member.memberId,
          subject,
          bodyHtml,
          bodySource: bodyHtml,
          segmentType: segment.kind,
          segmentParams:
            segment.kind === 'tier' ? { tierCodes: segment.tierCodes } : null,
          customRecipientEmails: segment.kind === 'custom' ? customLines : null,
          scheduledFor,
        },
      });
      if (!saved.ok) {
        // A field refusal (subject too long, body too large / unsafe) belongs
        // on the field, exactly as on submit. Everything else is a SAVE
        // failure and must not borrow the submit copy — "Couldn't submit the
        // broadcast" after pressing Save as draft reads as a lost draft.
        if (ERROR_HANDLING[saved.code] !== undefined) {
          handleErrorCode(saved.code, member.companyName);
        } else {
          toast.error(t('draftSaveErrorToast'));
        }
        return;
      }
      if (currentDraftId === null && saved.broadcastId !== null) {
        setCurrentDraftId(saved.broadcastId);
      }
      toast.success(t('draftSavedToast'));
      dirtyGuard.markSaved(savedSnapshot);
    } finally {
      setSubmitting(false);
      setSavingDraft(false);
    }
  }

  return (
    <div className="min-w-0 space-y-6">
      {/* Portal live walk U27 (FR-045) — unload AND in-app navigation, the
          same guard the member form renders. */}
      <UnsavedChangesGuard armed={dirtyGuard.armed} />
      {/* F119 T145 (FR-039) — the PROXIED member's allowance, from the staff
          quota route. Keyed on the member so picking another one re-fetches
          rather than showing the previous member's numbers; nothing at all is
          rendered before a member is picked, because there is no allowance to
          show yet. */}
      {member !== null ? (
        <QuotaDisplay
          key={member.memberId}
          endpoint={`/api/admin/broadcasts/quota?memberId=${encodeURIComponent(member.memberId)}`}
        />
      ) : null}
      {/* F119 T145 (FR-039) — the member form's template picker, with the same
          "this would overwrite what you typed" confirmation (FR-046). */}
      <ComposeTemplatePickerField
        templates={templates}
        selectedId={selectedTemplateId}
        hasContent={composeHasContent(subject, bodyHtml)}
        onApply={applyTemplate}
        disabled={submitting}
      />
      {/* F119 T148 (FR-050) — editor beside the 600 px email preview from `lg`
          up, stacked below; the page supplies the 72 rem container. */}
      <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,600px)]">
        <Card>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <MemberPicker
                value={member}
                onSelect={(m) => {
                  // A different member means a different draft and a different
                  // allowance — never carry the previous member's draft id
                  // across, or the next PUT names a row that is not theirs.
                  if (m?.memberId !== member?.memberId) setCurrentDraftId(null);
                  setMember(m);
                  setMemberError(null);
                }}
                label={t('memberLabel')}
                placeholder={t('memberPlaceholder')}
                searchFailedText={t('searchFailed')}
                emptyText={t('noResults')}
                loadingText={tLink('loading')}
                disabled={submitting}
                triggerRef={pickerRef}
              />
              {memberError !== null ? (
                <p role="alert" className="text-xs text-destructive">
                  {memberError}
                </p>
              ) : null}
              {memberMissingEmail ? (
                // Inline warning: shown immediately on member selection when
                // the picked member has no primary contact email. Prevents
                // submission before the admin fills in the gap. `role="alert"`
                // announces it to SR users without stealing focus (WCAG 4.1.3
                // Status Messages).
                <p
                  id={MISSING_EMAIL_ID}
                  role="alert"
                  className="text-xs text-destructive"
                >
                  {t('missingContactEmailWarning')}
                </p>
              ) : null}
            </div>

            {/* SegmentPicker / SchedulePicker / SubmitButton are the shared
                member-facing compose sub-components and intentionally render
                their own `portal.broadcasts.compose.*` copy. Reusing them
                (rather than forking admin variants) is the accepted trade-off
                of the proxy-compose reuse approach — the admin-specific copy
                lives only in the fields this form owns directly. */}
            <SegmentPicker
              value={segment}
              onChange={(next) => {
                setSegment(next);
                if (fieldError?.field === 'segment') setFieldError(null);
              }}
              disabled={submitting}
            />
            {member !== null &&
            !memberMissingEmail &&
            proxySelfExclusionNotice !== null ? (
              // UX-review fix (DV-4) — WCAG 4.1.3 Status Messages:
              // `role="status"` (implicit aria-live="polite") so SR users hear
              // it without focus moving. Round 2 (UX H-1 + i18n H3): it FOLLOWS
              // the segment picker and follows the segment — it used to render
              // on member selection regardless of segment, above the picker,
              // promising an exclusion that the custom list and the attendee
              // segment do not apply. /code-review (the pass after #6): a
              // segment kind this build does not recognise yields null and the
              // notice is omitted, rather than falling to "{company} WILL
              // receive this broadcast".
              <p role="status" className="text-sm text-muted-foreground">
                {t(proxySelfExclusionNotice, { company: member.companyName })}
              </p>
            ) : null}

            {fieldError?.field === 'segment' ? (
              <p role="alert" className="text-xs text-destructive">
                {fieldError.message}
              </p>
            ) : null}
            {/* 108 PR-C T089 (FR-040): live count for the proxied member. */}
            <RecipientCountLine
              state={recipientCount}
              textId={RECIPIENT_COUNT_TEXT_ID}
              onRetry={() => setCountRetry((n) => n + 1)}
            />

            {segment.kind === 'custom' ? (
              <CustomListInput
                value={customList}
                onChange={(next) => {
                  setCustomList(next);
                  if (fieldError?.field === 'customList') setFieldError(null);
                }}
                disabled={submitting}
              />
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="proxy-broadcast-subject">
                {t('subjectLabel')}
              </Label>
              <Input
                ref={subjectRef}
                id="proxy-broadcast-subject"
                data-compose-feature="subject"
                value={subject}
                onChange={(e) => {
                  setSubject(e.target.value);
                  if (fieldError?.field === 'subject') setFieldError(null);
                }}
                maxLength={200}
                disabled={submitting}
                aria-invalid={fieldError?.field === 'subject' || undefined}
                aria-describedby={
                  fieldError?.field === 'subject'
                    ? 'proxy-broadcast-subject-error proxy-broadcast-subject-counter'
                    : 'proxy-broadcast-subject-counter'
                }
              />
              {fieldError?.field === 'subject' ? (
                <p
                  id="proxy-broadcast-subject-error"
                  role="alert"
                  className="text-xs text-destructive"
                >
                  {fieldError.message}
                </p>
              ) : null}
              {/* F119 T145 (FR-039) — the member form's subject counter. */}
              <SubjectCounter
                id="proxy-broadcast-subject-counter"
                value={subject}
              />
            </div>

            {/* F119 T144 (FR-048): `aria-invalid` + `aria-describedby` used to
                live on THIS wrapper, which is not the control anyone focuses.
                Both now travel into the editor as props, the way
                `admin/template-form.tsx:283-286` already did it. The div keeps
                `tabIndex={-1}` only so a server error can move focus here. */}
            <div
              ref={bodyContainerRef}
              tabIndex={-1}
              data-compose-feature="body-editor"
              className="space-y-2 outline-none"
            >
              <Label id="proxy-broadcast-body-label">{t('bodyLabel')}</Label>
              <TiptapEditor
                key={editorSeed.nonce}
                initialHtml={editorSeed.html}
                invalid={bodyHasError}
                imagesEnabled={imagesEnabled}
                draftId={currentDraftId}
                {...(currentDraftId !== null
                  ? {
                      imageUploadUrl: `/api/admin/broadcasts/${currentDraftId}/images`,
                    }
                  : {})}
                {...(bodyHasError ? { describedById: BODY_ERROR_ID } : {})}
                onChange={(next) => {
                  setBodyHtml(next);
                  if (fieldError?.field === 'body') setFieldError(null);
                }}
                disabled={submitting}
                labelledById="proxy-broadcast-body-label"
              />
              {fieldError?.field === 'body' ? (
                <p
                  id={BODY_ERROR_ID}
                  role="alert"
                  className="text-xs text-destructive"
                >
                  {fieldError.message}
                </p>
              ) : bodyInvalid ? (
                // U29 — the member form's local over-size line, which this one
                // lacked: Submit was dimmed on a too-large paste with nothing
                // said until the server refused it.
                <p
                  id={BODY_ERROR_ID}
                  role="alert"
                  className="text-xs text-destructive"
                >
                  {tCompose('errors.broadcast_body_too_large')}
                </p>
              ) : null}
            </div>

            <SchedulePicker
              value={scheduledFor}
              onChange={setScheduledFor}
              disabled={submitting}
            />

            {/* U29 — the reason a dimmed Submit is dimmed, for the cases with
                no element of their own. "Needs input" is not an error state,
                so it is muted rather than red. */}
            {blockedReasonMessage !== null ? (
              <p
                id={SUBMIT_BLOCKED_HINT_ID}
                data-compose-feature="submit-blocked-reason"
                className="text-xs text-muted-foreground"
              >
                {blockedReasonMessage}
              </p>
            ) : null}

            <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-end">
              {/* F119 T145 (FR-045) — the member form's save receipt, same
                  test id, same `aria-live`, same next-intl formatter. */}
              {dirtyGuard.savedAt !== null ? (
                <p
                  data-testid="compose-saved-at"
                  data-compose-feature="saved-at"
                  className="text-xs text-muted-foreground sm:mr-auto"
                  aria-live="polite"
                >
                  {t('savedAt', {
                    time: formatLocalisedDate(dirtyGuard.savedAt, locale, TIME_HH_MM),
                  })}
                </p>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                data-compose-feature="save-draft"
                onClick={() => {
                  void handleSaveDraft();
                }}
                // A draft is stored against a member, so there is nothing to
                // save until one is picked — the route would 400 on the
                // missing `memberId`.
                disabled={submitting || member === null}
                aria-busy={savingDraft || undefined}
              >
                {savingDraft ? (
                  <Loader2Icon
                    className="size-4 motion-safe:animate-spin"
                    aria-hidden="true"
                  />
                ) : null}
                {t('saveDraftButton')}
              </Button>
              <SubmitButton
                disabled={submitDisabled}
                submitting={submitting}
                blockedReasonIds={submitBlockedReasonIds}
                onClick={() => {
                  void handleSubmit();
                }}
              />
            </div>
          </CardContent>
        </Card>

        <div className="min-w-0 lg:sticky lg:top-4">
          <PreviewPane
            subject={subject}
            bodyHtml={deferredBody}
            endpoint="/api/admin/broadcasts/preview"
            locale={locale}
          />
        </div>
      </div>
    </div>
  );
}
