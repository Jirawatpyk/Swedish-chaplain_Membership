'use client';

/**
 * T115 — Typed-phrase confirmation field for full refunds (FR-029(f)).
 *
 * Renders ONLY when the user has entered an amount equal to the
 * remaining refundable balance (i.e. a full refund). The user must
 * type the exact text `REFUND <company_name>` (case-sensitive
 * locale-aware compare) before the parent's Confirm button enables.
 *
 * Why case-sensitive: full refunds against paid invoices are
 * irreversible (Stripe's refund-creation API does not support undo
 * after the refund completes). The typed-phrase gate is the last
 * defence against wrong-row mistakes — a case-sensitive compare
 * makes muscle-memory shortcuts (auto-capitalise, etc.) miss, which
 * is the desired friction.
 */
import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Props = {
  readonly companyName: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
};

export function TypedPhraseConfirm({ companyName, value, onChange }: Props) {
  const t = useTranslations('admin.refund.form.typedPhrase');
  const fieldId = useId();
  const helpId = `${fieldId}-help`;
  const errorId = `${fieldId}-error`;

  const expected = `REFUND ${companyName}`;
  // Refund is deliberately case-SENSITIVE (unlike Issue/Void, which are
  // case-insensitive) — a completed Stripe refund cannot be undone, so the extra
  // friction is intentional. See design 2026-07-18 §Decisions(4). Not drift.
  const matches = value === expected;
  const hasInput = value.length > 0;
  const showError = hasInput && !matches;

  return (
    <div className="grid gap-2">
      <Label htmlFor={fieldId}>
        {t('label', { phrase: expected })}
      </Label>
      <Input
        id={fieldId}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('placeholder', { phrase: expected })}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="done"
        aria-describedby={showError ? `${helpId} ${errorId}` : helpId}
        aria-invalid={showError}
        aria-required="true"
        data-testid="refund-typed-phrase-input"
      />
      <p id={helpId} className="text-xs text-muted-foreground">
        {t('help')}
      </p>
      {showError && (
        // I10: visible error explains WHY the
        // Confirm button stays disabled — without this, an admin
        // who mistypes sees a disabled button + no feedback.
        // `role="alert"` triggers SR live-region announcement.
        <p
          id={errorId}
          role="alert"
          className="text-xs text-destructive"
          data-testid="refund-typed-phrase-error"
        >
          {t('mismatch', { phrase: expected })}
        </p>
      )}
    </div>
  );
}
