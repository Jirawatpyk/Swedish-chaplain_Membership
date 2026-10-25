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
 *
 * Spec 122 US12d-2: an AURA `Dialog` with AURA fields. The refusal is the
 * field's AURA `error` (its `aria-invalid` and `aria-describedby`), and its
 * text sits in a `role="alert"` so it is spoken the moment the save is
 * refused. Enter submits through the form.
 */
import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Dialog, TextField } from '@jirawatpyk/aura-react';
import { BROADCAST_ALLOWED_URI_REGEXP } from '@/lib/broadcast-content-policy';
import { withDefaultScheme } from './with-default-scheme';

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
  /** A link is under the caret: the dialog edits it ("Edit link"). */
  readonly editing?: boolean;
  /**
   * The selection spans blocks, so its words cannot be replaced by one line
   * of text without merging paragraphs: the text is shown, not editable.
   */
  readonly textReadOnly?: boolean;
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
  editing = false,
  textReadOnly = false,
  finalFocus,
}: LinkDialogProps): React.ReactElement {
  const t = useTranslations('broadcast.editor.linkDialog');
  const [href, setHref] = useState<string>(initialHref);
  const [text, setText] = useState<string>(initialText);
  const [error, setError] = useState<LinkError>(null);
  const formId = `${useId()}-link-form`;

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
    const trimmedHref = withDefaultScheme(href);
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
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      finalFocus={() => finalFocus?.() || null}
      size="sm"
      title={editing ? t('editTitle') : t('title')}
      description={t('description')}
      footer={
        <>
          {canRemove && (
            <Button
              variant="ghost"
              className="sm:me-auto"
              onClick={() => {
                onRemove?.();
                onOpenChange(false);
              }}
            >
              {t('remove')}
            </Button>
          )}
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
          error={errorText !== null ? <span role="alert">{errorText}</span> : undefined}
        />
        <TextField
          label={t('textLabel')}
          touchHeight
          value={text}
          readOnly={textReadOnly}
          hint={textReadOnly ? t('textReadOnlyHint') : t('textHint')}
          onChange={(e) => setText(e.target.value)}
        />
      </form>
    </Dialog>
  );
}
