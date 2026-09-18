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
 * Still missing, and not buildable in PR-1: draft save/resume, inline images
 * and the proxied member's allowance. Each needs a staff API route that does
 * not exist — `/api/broadcasts/draft` and `/api/broadcasts/quota` are both
 * `requireMemberContext`-gated, `POST /api/admin/broadcasts/[id]/images` needs
 * a staff-owned `draft` broadcast id that nothing here can mint, and
 * `contracts/admin-eblast-formatting-api.md` defines no staff equivalent of
 * any of the three.
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
import { toast } from 'sonner';
import {
  errorValues,
  excludedByPreference,
  PREFERENCE_TOAST_DURATION_MS,
  proxySelfExclusionNoticeKey,
  submitBlockedByCount,
} from '@/components/broadcast/submit-feedback';
import { z } from 'zod';
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

// Proxy form drops inline images + draft lifecycle (no staff route exists for
// either — see the file header) — the Tiptap editor is loaded with the same
// loader the member compose form uses, minus the `imagesEnabled` / `draftId`
// props.
const TiptapEditor = loadTiptapEditor<{
  initialHtml: string;
  onChange: (html: string) => void;
  disabled?: boolean;
  labelledById?: string;
  // F119 T144 (FR-048) — the error belongs on the `contenteditable`.
  describedById?: string;
  invalid?: boolean;
}>(() => import('./tiptap-editor'));

const INITIAL_BODY_HTML = '<p></p>';
const BODY_ERROR_ID = 'proxy-broadcast-body-error';

const SubmitSchema = z.object({
  subject: z.string().min(1).max(200),
  bodyHtml: z.string().min(1).max(200 * 1024),
});

/**
 * Field-level server error target. `null` for form-level errors handled
 * by toast. Mirrors `compose-form.tsx`'s `ServerErrorField`.
 */
type ServerErrorField = 'subject' | 'body' | 'segment' | null;

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
        | 'subjectTooLongError'
        | 'bodyTooLargeError'
        | 'bodyUnsafeHtmlError'
        | 'emptySegmentError'
        | 'audienceTooLargeError';
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
}

export function ProxyComposeForm({
  audienceCeiling,
  templates = [],
}: ProxyComposeFormProps): React.ReactElement {
  const t = useTranslations('admin.broadcasts.proxySubmitDialog');
  // The proxySubmitDialog namespace has no member-search loading string;
  // reuse the canonical members-picker loading copy ("Loading members…")
  // rather than hardcoding a new string.
  const tLink = useTranslations('admin.users.invite.linkMember');
  // The preview is rendered server-side in the staff user's own UI language.
  const locale = useLocale();
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

  // F119 T145 (FR-039/FR-045) — the unsaved-changes guard the member form has.
  // With no draft endpoint on this side, `markSaved` is never called, so it
  // stays a plain "you have typed something" warning until a submit is in
  // flight (`suspended`), which is exactly the parity item FR-039 asks for.
  useComposeDirtyGuard(
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
  const submitDisabled =
    member === null ||
    memberMissingEmail ||
    !validation.success ||
    !customListValid ||
    !tierValid ||
    // Round 2 (UX H-4): a measured refusal from the live count blocks here too.
    submitBlockedByCount(recipientCount);

  const bodyHasError = fieldError?.field === 'body';

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

  return (
    <div className="min-w-0 space-y-6">
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
                <p role="alert" className="text-xs text-destructive">
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
              onRetry={() => setCountRetry((n) => n + 1)}
            />

            {segment.kind === 'custom' ? (
              <CustomListInput
                value={customList}
                onChange={setCustomList}
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
              className="space-y-2 outline-none"
            >
              <Label id="proxy-broadcast-body-label">{t('bodyLabel')}</Label>
              <TiptapEditor
                key={editorSeed.nonce}
                initialHtml={editorSeed.html}
                invalid={bodyHasError}
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
              ) : null}
            </div>

            <SchedulePicker
              value={scheduledFor}
              onChange={setScheduledFor}
              disabled={submitting}
            />

            <div className="flex justify-end border-t pt-4">
              <SubmitButton
                disabled={submitDisabled}
                submitting={submitting}
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
