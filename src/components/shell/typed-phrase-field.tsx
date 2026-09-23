'use client';

/**
 * Typed-phrase confirmation field (ux-standards § 6.3), extracted from
 * `clear-halt-dialog.tsx` so the E-Blast cancel dialog (F119 walk U35) gates
 * its irreversible confirm with the SAME field and the SAME matching rule.
 *
 * Controlled: the caller owns the value (so it can reset it on open) and
 * derives `matches` from {@link typedPhraseMatches} to disable its confirm.
 *
 * Not for the full-refund gate (`refund-dialog/typed-phrase-confirm.tsx`),
 * which is deliberately case-SENSITIVE — a different rule, on purpose.
 */
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Review UX-C3 + UX-R2-2 (clear-halt round 3): a typed phrase matches when the
 * human-visible content matches — case, leading/trailing space, internal
 * whitespace runs and common punctuation are normalised away. Thai/Swedish
 * diacritics still matter (different base characters → not a match), so a
 * misspelling still blocks the destructive action.
 */
function normalizePhrase(s: string): string {
  return (
    s
      .trim()
      // Round-4 HIGH-H — `\s` covers ASCII/Unicode whitespace; explicit \u
      // escapes for zero-width chars (ZWSP / ZWNJ / ZWJ / BOM) so the regex
      // source is unambiguous regardless of editor encoding.
      .replace(/[\s​‌‍﻿]+/g, ' ')
      .replace(/[.,;:!?'"()\-—]/g, '') // strip common punctuation
      .toLowerCase()
  );
}

export function typedPhraseMatches(typed: string, expected: string): boolean {
  return normalizePhrase(typed) === normalizePhrase(expected);
}

export interface TypedPhraseFieldProps {
  /** Input id; the mismatch error is `${id}-error`. */
  readonly id: string;
  /** Visible label, already interpolated (e.g. "Type CANCEL to confirm"). */
  readonly label: string;
  /** The phrase to type — also shown as a copy target under the label. */
  readonly phrase: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
  /** Shown (and announced) only while the non-empty value does not match. */
  readonly errorMessage: string;
  readonly disabled?: boolean;
}

export function TypedPhraseField({
  id,
  label,
  phrase,
  value,
  onChange,
  errorMessage,
  disabled = false,
}: TypedPhraseFieldProps): React.ReactElement {
  const errorId = `${id}-error`;
  const showError = value.length > 0 && !typedPhraseMatches(value, phrase);
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {/* UX-C3: the expected phrase as a copy target, so nobody has to
          retype while squinting between fields. */}
      <code className="block rounded bg-muted px-2 py-1 text-xs font-mono">{phrase}</code>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        aria-invalid={showError}
        aria-describedby={showError ? errorId : undefined}
      />
      {showError ? (
        <p id={errorId} className="text-xs text-destructive" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
