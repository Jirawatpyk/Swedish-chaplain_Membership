'use client';

/**
 * F119 T089 + T099 (FR-040) — the image description dialog.
 *
 * Every image the writing tool inserts — inline or full-width banner — passes
 * through here FIRST, so the node cannot exist without an `alt` a recipient's
 * screen reader can read and an image-blocking mail client can show. It is a
 * description dialog, never an upload field: the file is chosen by the
 * uploader, the words are collected here.
 *
 * "Announced" (US3-AS2) is the whole point of the error path, so it is three
 * things together, not a red border: `aria-invalid` on the field, the message
 * referenced by `aria-describedby`, and the message itself in a `role="alert"`
 * live region so it is spoken the moment the insert is refused.
 *
 * The 1–125 bound is the Domain's (`BANNER_ALT_MIN`/`MAX` via the client-safe
 * re-export), the same numbers `validateBlocks` refuses with on the server —
 * a second copy here would drift and start promising an insert the submit
 * then rejects.
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
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { BANNER_ALT_MAX, BANNER_ALT_MIN } from '@/lib/design-blocks-client';

export type ImageAltVariant = 'inline' | 'banner';

export interface ImageAltDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
  /** Only changes the copy — the rule and the bound are identical for both. */
  readonly variant: ImageAltVariant;
  readonly onConfirm: (alt: string) => void;
  /** Focus-return target on close; EVERY dialog in this codebase supplies one. */
  readonly finalFocus?: () => HTMLElement | false | null;
}

type AltError = 'required' | 'tooLong' | null;

export function ImageAltDialog({
  open,
  onOpenChange,
  variant,
  onConfirm,
  finalFocus,
}: ImageAltDialogProps): React.ReactElement {
  const t = useTranslations('broadcast.editor.altDialog');
  const [value, setValue] = useState<string>('');
  const [error, setError] = useState<AltError>(null);
  const fieldId = useId();
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;

  // A fresh open is a fresh description — carrying the previous image's words
  // over is worse than an empty field, because it looks deliberate. Uses the
  // render-time "adjust state when a prop changes" pattern (not an effect), as
  // `reason-confirmation-dialog.tsx` does, to avoid the cascading-render rule.
  const [prevOpen, setPrevOpen] = useState<boolean>(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setValue('');
      setError(null);
    }
  }

  const submit = (): void => {
    const trimmed = value.trim();
    if (trimmed.length < BANNER_ALT_MIN) {
      setError('required');
      return;
    }
    if (trimmed.length > BANNER_ALT_MAX) {
      setError('tooLong');
      return;
    }
    onConfirm(trimmed);
    onOpenChange(false);
  };

  const errorText =
    error === 'required'
      ? t('errors.required', { min: BANNER_ALT_MIN, max: BANNER_ALT_MAX })
      : error === 'tooLong'
        ? t('errors.tooLong', { max: BANNER_ALT_MAX })
        : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>{variant === 'banner' ? t('bannerTitle') : t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <Label htmlFor={fieldId}>{t('fieldLabel')}</Label>
          <Textarea
            id={fieldId}
            value={value}
            rows={2}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            {...(error !== null && { 'aria-invalid': true })}
            aria-describedby={error !== null ? `${hintId} ${errorId}` : hintId}
          />
          <p id={hintId} className="text-caption text-muted-foreground">
            {t('counter', { count: value.trim().length, max: BANNER_ALT_MAX })}
          </p>
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
            {variant === 'banner' ? t('bannerInsert') : t('insert')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
