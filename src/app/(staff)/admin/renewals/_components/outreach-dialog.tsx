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
 */
'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

const CHANNELS = ['email', 'phone', 'meeting'] as const;
type Channel = (typeof CHANNELS)[number];

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
}

export function OutreachDialog({
  open,
  onOpenChange,
  memberId,
  memberCompanyName,
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
          toast.error(t('toast.failure'), {
            description: t(`toast.error.${code}`, {
              fallback: t('toast.error.server_error'),
            }),
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
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent initialFocus={cancelRef}>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {memberCompanyName
              ? t('description', { company: memberCompanyName })
              : t('descriptionFallback')}
          </DialogDescription>
        </DialogHeader>
        <div className="my-3 space-y-4">
          <div className="space-y-1">
            <Label htmlFor="outreach-channel">{t('channel.label')}</Label>
            <Select
              value={channel}
              onValueChange={(v) => setChannel(v as Channel)}
            >
              <SelectTrigger id="outreach-channel">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CHANNELS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {t(`channel.option.${c}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {channel === 'email' && (
            <div className="space-y-1">
              <Label htmlFor="outreach-template">
                {t('template.label')}
              </Label>
              <Select
                value={templateId}
                onValueChange={(v) => setTemplateId(v ?? EMAIL_TEMPLATES[0])}
              >
                <SelectTrigger id="outreach-template">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EMAIL_TEMPLATES.map((tpl) => (
                    <SelectItem key={tpl} value={tpl}>
                      {t(`template.option.${tpl.replace(/\./g, '_')}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="outreach-note">{t('note.label')}</Label>
            <Textarea
              id="outreach-note"
              value={outcomeNote}
              onChange={(e) => setOutcomeNote(e.target.value)}
              placeholder={t('note.placeholder')}
              rows={3}
              maxLength={OUTCOME_NOTE_MAX + 50}
              aria-describedby="outreach-note-counter"
            />
            {/*
             * R4-S2 (staff-review-2026-05-09): WCAG 4.1.3 Status Messages
             * — character-counter MUST announce changes to AT users
             * typing in the textarea. `aria-live="polite"` queues the
             * announcement without interrupting; `aria-atomic="true"`
             * ensures the full counter (X / Y characters) is read each
             * time, not just the changed digit.
             */}
            <p
              id="outreach-note-counter"
              aria-live="polite"
              aria-atomic="true"
              className={
                'text-xs ' +
                (noteOver
                  ? 'text-destructive'
                  : 'text-muted-foreground')
              }
            >
              {t('note.counter', { count: noteCount, max: OUTCOME_NOTE_MAX })}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button
            ref={cancelRef}
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {t('cancel')}
          </Button>
          <Button
            onClick={onConfirm}
            disabled={pending || noteOver}
          >
            {pending ? t('submitting') : t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
