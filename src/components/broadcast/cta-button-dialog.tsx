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
import { Button, Dialog, TextField } from '@jirawatpyk/aura-react';
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
  const formId = `${useId()}-cta-form`;

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

  const counter = t('counter', { count: text.trim().length, max: CTA_TEXT_MAX });
  // The refusal is the faulty field's AURA `error`, its text in a
  // `role="alert"` so it is spoken the moment the insert is refused. AURA's
  // error replaces the hint, so the text field's counter rides along with it.
  const alert = errorText !== null ? <span role="alert">{errorText}</span> : null;

  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      finalFocus={() => finalFocus?.() || null}
      size="sm"
      title={t('title')}
      description={t('description')}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button variant="primary" type="submit" form={formId}>
            {t('confirm')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <TextField
          label={t('textLabel')}
          touchHeight
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          hint={counter}
          error={
            textInvalid ? (
              <>
                {alert} {counter}
              </>
            ) : undefined
          }
        />
        <TextField
          label={t('urlLabel')}
          touchHeight
          inputMode="url"
          // A URL on a phone keyboard: no autocorrect or capital first
          // letter, the browser's URL suggestions, "done" on the return key.
          enterKeyHint="done"
          autoComplete="url"
          autoCapitalize="none"
          spellCheck={false}
          value={href}
          placeholder={t('urlPlaceholder')}
          onChange={(e) => {
            setHref(e.target.value);
            setError(null);
          }}
          error={hrefInvalid ? alert : undefined}
        />
      </form>
    </Dialog>
  );
}
