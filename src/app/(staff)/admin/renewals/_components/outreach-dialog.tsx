/**
 * F8 Phase 6 Wave E · T170 — `OutreachDialog`.
 *
 * Admin OR manager (FR-052a manager exception) record-outreach dialog.
 * Channel select (`email | phone | meeting`) + conditional template_id
 * select shown only when channel='email' (mirrors migration 0090
 * channel-template CHECK) + outcome-note textarea (≤500 chars with
 * live counter). On submit, POSTs to
 * `/api/admin/renewals/at-risk/[memberId]/outreach` and shows toast.
 *
 * UX standards: live counter for outcome_note (docs/ux-standards.md
 * § 6.3); focus on Cancel by default (defensive default for any
 * dialog with side effects).
 *
 * 122 US7a (T706): AURA `Dialog` (`role="alertdialog"`, Cancel focused
 * first) with AURA `Select`s and `Textarea`; the counter is the note's hint,
 * and a note over the limit is its error. The request body, error mapping
 * and toasts are unchanged.
 */
'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from '@/lib/toast';
import { Button, Dialog, Select, Textarea } from '@jirawatpyk/aura-react';
// 067 #4 review-fix — single-source the channel list (mirrors the
// `at_risk_outreach.channel` CHECK at migration 0090) instead of a hand-
// maintained local copy that silently drifts if a 4th channel is added.
// Imported via the client-safe sub-barrel (`@/modules/renewals/client`),
// NOT the full barrel: this is a `'use client'` component and the full
// barrel pulls the server-side graph (postgres/fs/net) into the browser
// bundle — see client.ts for the Turbopack-eager-walk rationale.
import {
  OUTREACH_CHANNELS as CHANNELS,
  type OutreachChannel as Channel,
} from '@/modules/renewals/client';

// Template IDs are taken from FR-013 / FR-014 + smart-chamber-features.md
// outreach catalogue. Compact list for MVP — extensible.
const EMAIL_TEMPLATES = [
  'at_risk.outreach.event_drought',
  'at_risk.outreach.benefit_underuse',
  'at_risk.outreach.payment_reminder',
] as const;

const OUTCOME_NOTE_MAX = 500;

export interface OutreachDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly memberId: string;
  readonly memberCompanyName: string | null;
  /**
   * Review fix #5 (WCAG 2.1 AA SC 2.4.3) — focus-return target on close.
   * `OutreachDialog` is opened from a row/menu-item trigger that can itself
   * unmount when the menu closes (Base UI's default focus-restore would
   * then drop focus to `<body>`). Callers pass a ref to a PERSISTENT
   * element in the row — typically the ⋯ trigger button, which survives
   * the menu closing — via `mergeRefs` where that trigger is a Base UI
   * `DropdownMenuTrigger` render-prop element. Optional: `lapsed-tab.tsx`
   * / `at-risk-widget.tsx` / `pipeline-table.tsx` all pass one; omitting it
   * falls back to Base UI's own default restore-focus behaviour.
   */
  readonly finalFocus?: React.RefObject<HTMLElement | null>;
}

export function OutreachDialog({
  open,
  onOpenChange,
  memberId,
  memberCompanyName,
  finalFocus,
}: OutreachDialogProps) {
  const t = useTranslations('admin.renewals.atRisk.outreach');
  const router = useRouter();
  const [channel, setChannel] = useState<Channel>('email');
  const [templateId, setTemplateId] = useState<string>(EMAIL_TEMPLATES[0]);
  const [outcomeNote, setOutcomeNote] = useState('');
  const [pending, startTransition] = useTransition();

  const onConfirm = () => {
    startTransition(async () => {
      const body: Record<string, unknown> = { channel };
      if (channel === 'email') body.template_id = templateId;
      const trimmedNote = outcomeNote.trim();
      if (trimmedNote.length > 0) body.outcome_note = trimmedNote;
      try {
        const res = await fetch(
          `/api/admin/renewals/at-risk/${encodeURIComponent(memberId)}/outreach`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
        );
        if (!res.ok) {
          let code = 'server_error';
          try {
            const errBody = (await res.json()) as {
              error?: { code?: string };
            };
            code = errBody.error?.code ?? code;
          } catch {
            /* ignore */
          }
          // next-intl's `t` has no `fallback` option — a missing key would
          // render the raw dotted KEY PATH. Guard with `t.has` and fall back
          // to the generic localized server_error copy for unmapped codes.
          const key = `toast.error.${code}`;
          toast.error(t('toast.failure'), {
            description: t.has(key) ? t(key) : t('toast.error.server_error'),
          });
          return;
        }
        toast.success(t('toast.success'));
        // Reset state for next open.
        setOutcomeNote('');
        onOpenChange(false);
        router.refresh();
      } catch {
        toast.error(t('toast.failure'));
      }
    });
  };

  const noteCount = outcomeNote.length;
  const noteOver = noteCount > OUTCOME_NOTE_MAX;

  // Phase 6 review S8 — focus on Cancel via @base-ui Dialog
  // `initialFocus` ref (mirrors snooze-dialog) per ux-standards § 4.
  const counter = t('note.counter', { count: noteCount, max: OUTCOME_NOTE_MAX });

  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      role="alertdialog"
      {...(finalFocus ? { finalFocus } : {})}
      title={t('title')}
      description={
        memberCompanyName
          ? t('description', { company: memberCompanyName })
          : t('descriptionFallback')
      }
      footer={
        <>
          <Button
            variant="secondary"
            data-autofocus=""
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {t('cancel')}
          </Button>
          <Button onClick={onConfirm} loading={pending} disabled={noteOver}>
            {pending ? t('submitting') : t('confirm')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-[var(--aura-space-4)]">
        <Select
          label={t('channel.label')}
          value={channel}
          onChange={(e) => setChannel(e.target.value as Channel)}
          options={CHANNELS.map((c) => ({ value: c, label: t(`channel.option.${c}`) }))}
        />
        {channel === 'email' ? (
          <Select
            label={t('template.label')}
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value || EMAIL_TEMPLATES[0])}
            options={EMAIL_TEMPLATES.map((tpl) => ({
              value: tpl,
              label: t(`template.option.${tpl.replace(/\./g, '_')}`),
            }))}
          />
        ) : null}
        {/* The counter is the hint; over the limit it becomes the field's
            error (aria-invalid, announced) and Record outreach is blocked.
            `maxLength` leaves 50 characters of slack so the over-limit state
            can be reached and explained rather than silently truncated. */}
        <Textarea
          label={t('note.label')}
          value={outcomeNote}
          onChange={(e) => setOutcomeNote(e.target.value)}
          placeholder={t('note.placeholder')}
          rows={3}
          maxLength={OUTCOME_NOTE_MAX + 50}
          {...(noteOver ? { error: counter } : { hint: counter })}
        />
      </div>
    </Dialog>
  );
}
