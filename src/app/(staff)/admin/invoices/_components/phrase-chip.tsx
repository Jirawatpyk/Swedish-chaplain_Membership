'use client';

/**
 * Spec 122 US8b (parity comments, 3 Oct; boards `Admin-void`,
 * `Admin-refund-full`): the phrase a typed confirmation asks for, in its own
 * chip with a copy button. Display only — what has to be typed, and how it is
 * compared, stay with the form. It goes in the TextField's `labelAddon`
 * (AURA 5.31, handoff #138) with `labelAddonDescribes={false}`, and the chip's
 * id goes into the input's `aria-describedby`, so a screen reader hears the
 * phrase and not the copy button's name.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { IconButton } from '@jirawatpyk/aura-react';
import { toast } from '@/lib/toast';

export function PhraseChip({
  id,
  phrase,
  testId,
}: {
  /** Put on the chip; the input lists it in `aria-describedby`. */
  readonly id: string;
  readonly phrase: string;
  readonly testId: string;
}) {
  const t = useTranslations('admin.invoices.phraseChip');
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(phrase);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      toast.error(t('copyFailed'));
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-[var(--aura-space-1)]">
      <code
        id={id}
        data-testid={testId}
        className="rounded-[var(--aura-radius-sm)] border border-[var(--aura-border-default)] bg-[var(--aura-bg-surface-hover)] px-[var(--aura-space-2)] py-[var(--aura-space-1)] font-mono text-sm text-[var(--aura-fg-primary)] break-all"
      >
        {phrase}
      </code>
      <IconButton icon={copied ? 'check' : 'copy'} label={t('copy', { phrase })} size="sm" touchHeight onClick={copy} />
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? t('copied', { phrase }) : ''}
      </span>
    </div>
  );
}
