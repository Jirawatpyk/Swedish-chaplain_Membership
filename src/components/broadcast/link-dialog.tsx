'use client';

/**
 * F119 T100 (FR-038) — the link dialog.
 *
 * It refuses a scheme outside the allow-list HERE, with an inline message,
 * rather than accepting it and letting the sanitiser strip it later — the
 * "silently removed between editor and delivered email" failure SC-011
 * forbids. The rule is `BROADCAST_ALLOWED_URI_REGEXP` from the ONE shared
 * content policy, the same expression the sanitiser runs, because `zod`'s
 * `.url()` accepts `javascript:` (it validates WHATWG URL shape, not scheme
 * safety) and a second hand-rolled list would drift from the sanitiser's.
 *
 * FR-038 also asks for editable link TEXT, which is why this is a dialog and
 * no longer the URL-only popover the toolbar carried before.
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

export interface BroadcastLink {
  readonly href: string;
  readonly text: string;
}

export interface LinkDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
  readonly onConfirm: (link: BroadcastLink) => void;
  /** Shown only when there is a link under the cursor to remove. */
  readonly canRemove?: boolean;
  readonly onRemove?: () => void;
  readonly initialHref?: string;
  readonly initialText?: string;
  readonly finalFocus?: () => HTMLElement | false | null;
}

type LinkError = 'required' | 'scheme' | null;

export function LinkDialog({
  open,
  onOpenChange,
  onConfirm,
  canRemove = false,
  onRemove,
  initialHref = '',
  initialText = '',
  finalFocus,
}: LinkDialogProps): React.ReactElement {
  const t = useTranslations('broadcast.editor.linkDialog');
  const [href, setHref] = useState<string>(initialHref);
  const [text, setText] = useState<string>(initialText);
  const [error, setError] = useState<LinkError>(null);
  const fieldId = useId();
  const urlId = `${fieldId}-url`;
  const textId = `${fieldId}-text`;
  const errorId = `${fieldId}-error`;

  // Re-seed from the selection every time the dialog opens — a stale href from
  // the previously edited link would silently re-point this one. Render-time
  // "adjust state when a prop changes" (not an effect), as
  // `reason-confirmation-dialog.tsx` does, to avoid the cascading-render rule.
  const [prevOpen, setPrevOpen] = useState<boolean>(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setHref(initialHref);
      setText(initialText);
      setError(null);
    }
  }

  const submit = (): void => {
    const trimmedHref = href.trim();
    if (trimmedHref === '') {
      setError('required');
      return;
    }
    if (!BROADCAST_ALLOWED_URI_REGEXP.test(trimmedHref)) {
      setError('scheme');
      return;
    }
    onConfirm({ href: trimmedHref, text: text.trim() });
    onOpenChange(false);
  };

  const errorText =
    error === 'required' ? t('errors.required') : error === 'scheme' ? t('errors.scheme') : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
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
              {...(error !== null && { 'aria-invalid': true })}
              {...(error !== null && { 'aria-describedby': errorId })}
            />
            {errorText !== null && (
              <p id={errorId} role="alert" className="text-caption text-destructive">
                {errorText}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={textId}>{t('textLabel')}</Label>
            <Input
              id={textId}
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </div>
        </div>

        <DialogFooter>
          {canRemove && (
            <Button
              type="button"
              variant="ghost"
              className="sm:mr-auto"
              onClick={() => {
                onRemove?.();
                onOpenChange(false);
              }}
            >
              {t('remove')}
            </Button>
          )}
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
