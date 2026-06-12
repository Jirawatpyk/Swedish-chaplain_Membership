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
  TranslatedSelectValue,
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
    // Fix 4 a11y: form-bearing confirmation dialog — kept as Dialog +
    // `role="alertdialog"`. DOM/a11y is correct: `initialFocus={cancelRef}`
    // delivers focus-on-Cancel; `role="alertdialog"` signals AT this
    // requires a response (ARIA 1.1 § 5.3.3). AlertDialogContent (===
    // Base UI AlertDialog.Popup) WOULD also accept `initialFocus` — kept
    // as Dialog is a stylistic choice, not a technical limitation.
    // See snooze-dialog.tsx for full rationale (same pattern).
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent initialFocus={cancelRef} role="alertdialog">
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
              <SelectTrigger id="outreach-channel" className="w-full">
                <TranslatedSelectValue
                  translate={(v) => t(`channel.option.${v}`)}
                />
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
                <SelectTrigger id="outreach-template" className="w-full">
                  <TranslatedSelectValue
                    translate={(v) =>
                      t(`template.option.${v.replace(/\./g, '_')}`)
                    }
                  />
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
             * R4-S2 + Round-5 review-finding M4: WCAG 4.1.3 Status
             * Messages — `aria-live` should announce on MEANINGFUL
             * state changes only. R4-S2 wired `aria-live="polite"`
             * + `aria-atomic="true"` on every keystroke (the counter
             * text re-renders on each character) which produced
             * "247 / 500 characters" announcements ~250 times for a
             * 250-char note — itself an accessibility regression on
             * NVDA + JAWS + VoiceOver.
             *
             * Round-5 M4 fix: `aria-live="polite"` ONLY when the
             * counter crosses into the over-limit state (`noteOver`).
             * Sighted users still see the counter every keystroke;
             * SR users only hear it when the limit is breached. Pre-
             * cross announcements are unhelpful (the user already
             * knows the limit from the textarea label). The aria-
             * atomic attribute is dropped from the non-over branch
             * so the live region is not "armed" while typing.
             */}
            <p
              id="outreach-note-counter"
              {...(noteOver
                ? ({
                    'aria-live': 'polite',
                    'aria-atomic': 'true',
                  } as const)
                : {})}
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
