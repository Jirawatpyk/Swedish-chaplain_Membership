'use client';

/**
 * F119 T102 (FR-041) — the call-to-action button dialog.
 *
 * The author supplies two things and nothing else: the label (1–60 characters)
 * and the link (http / https / mailto). Colour, font, size and spacing belong
 * to the platform and the chamber's brand settings, so there is deliberately
 * no control for them here — FR-041 forbids a user setting them at all.
 *
 * Both bounds come from the Domain through the client-safe re-export
 * (`CTA_TEXT_MIN`/`MAX`) and the scheme rule from the ONE shared content
 * policy, so the dialog refuses exactly what `validateBlocks` and the
 * sanitiser refuse — never a little less.
 */
import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { BROADCAST_ALLOWED_URI_REGEXP } from '@/lib/broadcast-content-policy';
import { CTA_TEXT_MAX, CTA_TEXT_MIN } from '@/lib/design-blocks-client';

export interface CtaButtonDraft {
  readonly href: string;
  readonly text: string;
}

export interface CtaButtonDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
  readonly onConfirm: (cta: CtaButtonDraft) => void;
  readonly finalFocus?: () => HTMLElement | false | null;
}

type CtaError = 'textRequired' | 'textTooLong' | 'required' | 'scheme' | null;

export function CtaButtonDialog({
  open,
  onOpenChange,
  onConfirm,
  finalFocus,
}: CtaButtonDialogProps): React.ReactElement {
  const t = useTranslations('broadcast.editor.ctaDialog');
  const [text, setText] = useState<string>('');
  const [href, setHref] = useState<string>('');
  const [error, setError] = useState<CtaError>(null);
  const fieldId = useId();
  const textId = `${fieldId}-text`;
  const urlId = `${fieldId}-url`;
  const counterId = `${fieldId}-counter`;
  const errorId = `${fieldId}-error`;

  // Render-time "adjust state when a prop changes" (not an effect), as
  // `reason-confirmation-dialog.tsx` does, to avoid the cascading-render rule.
  const [prevOpen, setPrevOpen] = useState<boolean>(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setText('');
      setHref('');
      setError(null);
    }
  }

  const submit = (): void => {
    const trimmedText = text.trim();
    const trimmedHref = href.trim();
    if (trimmedText.length < CTA_TEXT_MIN) {
      setError('textRequired');
      return;
    }
    if (trimmedText.length > CTA_TEXT_MAX) {
      setError('textTooLong');
      return;
    }
    if (trimmedHref === '') {
      setError('required');
      return;
    }
    if (!BROADCAST_ALLOWED_URI_REGEXP.test(trimmedHref)) {
      setError('scheme');
      return;
    }
    onConfirm({ href: trimmedHref, text: trimmedText });
    onOpenChange(false);
  };

  const errorText =
    error === 'textRequired'
      ? t('errors.textRequired', { min: CTA_TEXT_MIN, max: CTA_TEXT_MAX })
      : error === 'textTooLong'
        ? t('errors.textTooLong', { max: CTA_TEXT_MAX })
        : error === 'required'
          ? t('errors.required')
          : error === 'scheme'
            ? t('errors.scheme')
            : null;

  const textInvalid = error === 'textRequired' || error === 'textTooLong';
  const hrefInvalid = error === 'required' || error === 'scheme';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor={textId}>{t('textLabel')}</Label>
            <Input
              id={textId}
              type="text"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setError(null);
              }}
              {...(textInvalid && { 'aria-invalid': true })}
              aria-describedby={textInvalid ? `${counterId} ${errorId}` : counterId}
            />
            <p id={counterId} className="text-caption text-muted-foreground">
              {t('counter', { count: text.trim().length, max: CTA_TEXT_MAX })}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={urlId}>{t('urlLabel')}</Label>
            <Input
              id={urlId}
              type="text"
              inputMode="url"
              value={href}
              placeholder={t('urlPlaceholder')}
              onChange={(e) => {
                setHref(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submit();
                }
              }}
              {...(hrefInvalid && { 'aria-invalid': true })}
              {...(hrefInvalid && { 'aria-describedby': errorId })}
            />
          </div>

          {errorText !== null && (
            <p id={errorId} role="alert" className="text-caption text-destructive">
              {errorText}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button type="button" onClick={submit}>
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
