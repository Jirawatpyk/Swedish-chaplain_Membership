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
 *   - Drops quota display, save-draft, and template-picker (admin proxy
 *     flow has no draft lifecycle and the member's quota is enforced
 *     server-side, surfaced via the `broadcast_quota_blocked` error toast).
 *   - Self-exclusion notice (Q16) once a member is picked: the proxied
 *     member never receives their own e-blast.
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
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
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

// Proxy form drops inline images + draft lifecycle — the Tiptap editor is
// loaded with the same loader the member compose form uses, minus the
// `imagesEnabled` / `draftId` props.
const TiptapEditor = loadTiptapEditor<{
  initialHtml: string;
  onChange: (html: string) => void;
  disabled?: boolean;
  labelledById?: string;
}>(() => import('./tiptap-editor'));

const INITIAL_BODY_HTML = '<p></p>';

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

export function ProxyComposeForm(): React.ReactElement {
  const t = useTranslations('admin.broadcasts.proxySubmitDialog');
  // The proxySubmitDialog namespace has no member-search loading string;
  // reuse the canonical members-picker loading copy ("Loading members…")
  // rather than hardcoding a new string.
  const tLink = useTranslations('admin.users.invite.linkMember');
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

  const deferredBody = useDeferredValue(bodyHtml);
  const customLines = parseLines(customList);

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
    !tierValid;

  // Auto-focus the failing field when a field-level server error arrives.
  useEffect(() => {
    if (fieldError === null) return;
    if (fieldError.field === 'subject') subjectRef.current?.focus();
    else if (fieldError.field === 'body') bodyContainerRef.current?.focus();
    // segment is a radio group — the inline error + toast suffices.
  }, [fieldError]);

  function handleErrorCode(code: string, companyName: string): void {
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
        const message = t(handling.key);
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
        toast.success(t('successToast', { company: companyName }));
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
      handleErrorCode(code, companyName);
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
            // Inline warning: shown immediately on member selection when the
            // picked member has no primary contact email. Prevents submission
            // before the admin fills in the gap. `role="alert"` announces it
            // to SR users without stealing focus (WCAG 4.1.3 Status Messages).
            <p role="alert" className="text-xs text-destructive">
              {t('missingContactEmailWarning')}
            </p>
          ) : null}
          {member !== null && !memberMissingEmail ? (
            // UX-review fix (DV-4) — WCAG 4.1.3 Status Messages: this
            // notice appears when a member is picked and focus returns to
            // the picker trigger, so it must be announced. `role="status"`
            // (implicit aria-live="polite") makes SR users hear it without
            // stealing focus. Scoped to the <p> rather than the wrapping
            // <div> so it does not interfere with the picker's combobox
            // interactions or the sibling member-not-found `role="alert"`.
            <p role="status" className="text-sm text-muted-foreground">
              {t('selfExclusionNotice', { company: member.companyName })}
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

        {fieldError?.field === 'segment' ? (
          <p role="alert" className="text-xs text-destructive">
            {fieldError.message}
          </p>
        ) : null}

        {segment.kind === 'custom' ? (
          <CustomListInput
            value={customList}
            onChange={setCustomList}
            disabled={submitting}
          />
        ) : null}

        <div className="space-y-2">
          <Label htmlFor="proxy-broadcast-subject">{t('subjectLabel')}</Label>
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
                ? 'proxy-broadcast-subject-error'
                : undefined
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
        </div>

        <div
          ref={bodyContainerRef}
          tabIndex={-1}
          className="space-y-2 outline-none"
          aria-invalid={fieldError?.field === 'body' || undefined}
          // WCAG 3.3.1: SR users hearing `aria-invalid` need the error
          // reason programmatically associated. The error <p> below carries
          // id="proxy-broadcast-body-error"; this `aria-describedby` wires
          // the chain. Note: ideally the inner Tiptap `contenteditable`
          // would also receive the describedby via `editorProps.attributes`
          // but that requires a TiptapEditor prop addition; the wrapper-
          // div-level association is what most SR pipelines resolve to
          // anyway when `aria-invalid` is on the wrapper. Mirrors the
          // accepted member compose-form compromise (compose-form.tsx).
          aria-describedby={
            fieldError?.field === 'body'
              ? 'proxy-broadcast-body-error'
              : undefined
          }
        >
          <Label id="proxy-broadcast-body-label">{t('bodyLabel')}</Label>
          <TiptapEditor
            initialHtml={INITIAL_BODY_HTML}
            onChange={(next) => {
              setBodyHtml(next);
              if (fieldError?.field === 'body') setFieldError(null);
            }}
            disabled={submitting}
            labelledById="proxy-broadcast-body-label"
          />
          {fieldError?.field === 'body' ? (
            <p
              id="proxy-broadcast-body-error"
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

        <PreviewPane subject={subject} bodyHtml={deferredBody} />

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
  );
}
