'use client';

/**
 * Typed-phrase confirmation field (ux-standards § 6.3), extracted from
 * `clear-halt-dialog.tsx` so the E-Blast cancel dialog (F119 walk U35) gates
 * its irreversible confirm with the SAME field and the SAME matching rule.
 * Clear-halt types a member's name; the cancel dialog types the E-Blast's
 * subject.
 *
 * Controlled: the caller owns the value (so it can reset it on open) and
 * derives `matches` from {@link typedPhraseMatches} to disable its confirm.
 *
 * Not for the full-refund gate (`refund-dialog/typed-phrase-confirm.tsx`),
 * which is deliberately case-SENSITIVE — a different rule, on purpose.
 */
import { useEffect, useRef, useState } from 'react';
import { CopyIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** Emoji variation selectors (VS1–VS16, incl. U+FE0F) and zero-width characters. */
const INVISIBLE = /[︀-️​-‍⁠﻿]/g;
/** A run of Thai combining marks (above / below vowels, tone marks, signs). */
const THAI_MARK_RUN = /[ัิ-ฺ็-๎]{2,}/g;
/** Common punctuation, incl. the curly quotes and dashes phone keyboards insert. */
const PUNCTUATION = /[.,;:!?'"()\-–—‘’“”]/g;

/**
 * Canonical order for a run of Thai marks: below vowels, then above vowels,
 * then tone marks, then the remaining signs. The same syllable typed with its
 * marks in either order renders identically, and Unicode normalisation does
 * NOT reorder them (the above vowels have combining class 0) — measured:
 * `ก่ี` ≠ `กี่` and `นํ้า` ≠ `น้ำ` under NFKC.
 */
function thaiMarkRank(c: string): number {
  const cp = c.codePointAt(0)!;
  if (cp >= 0x0e38 && cp <= 0x0e3a) return 0; // below vowels, PHINTHU
  if (cp >= 0x0e48 && cp <= 0x0e4b) return 2; // tone marks
  if (cp >= 0x0e4c) return 3; // THANTHAKHAT, NIKHAHIT, YAMAKKAN
  return 1; // MAI HAN-AKAT, above vowels, MAITAIKHU
}

/**
 * Review UX-C3 + UX-R2-2 (clear-halt round 3), widened for F119 U35: a typed
 * phrase matches when the human-visible content matches. NFKC (so ำ equals
 * ํา and full-width forms equal ASCII); invisible characters dropped; Thai
 * marks in one order; punctuation dropped BEFORE whitespace is collapsed (so
 * "a — b" and "a b" agree); trimmed; lower-cased with the locale-independent
 * `toLowerCase`. Different base letters (Thai or Swedish diacritics included)
 * still differ, so a misspelling still blocks the destructive action.
 */
export function normalizeTypedPhrase(s: string): string {
  return s
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(THAI_MARK_RUN, (run) =>
      [...run].sort((a, b) => thaiMarkRank(a) - thaiMarkRank(b)).join(''),
    )
    .replace(PUNCTUATION, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function typedPhraseMatches(typed: string, expected: string): boolean {
  return normalizeTypedPhrase(typed) === normalizeTypedPhrase(expected);
}

export interface TypedPhraseFieldProps {
  /** Input id; the mismatch error is `${id}-error`. */
  readonly id: string;
  /** Visible label, already interpolated (e.g. "Type CANCEL to confirm"). */
  readonly label: string;
  /** The phrase to type — also shown in full as a copy target under the label. */
  readonly phrase: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
  /** Shown (and announced) for a non-matching value, once blurred or as long as the phrase. */
  readonly errorMessage: string;
  /** What the matching forgives, shown under the input. */
  readonly helpText?: string;
  /** A "copy the phrase" button, announcing `copiedMessage` politely on success. */
  readonly copy?: { readonly label: string; readonly copiedMessage: string };
  /** Enter in the input — the caller's confirm (it re-checks validity itself). */
  readonly onSubmit?: () => void;
  readonly disabled?: boolean;
  /**
   * The input keeps focus but takes no typing — for a request in flight,
   * where `disabled` would drop the focus it holds to <body> (Enter in this
   * input is what started the request).
   */
  readonly readOnly?: boolean;
}

export function TypedPhraseField({
  id,
  label,
  phrase,
  value,
  onChange,
  errorMessage,
  helpText,
  copy,
  onSubmit,
  disabled = false,
  readOnly = false,
}: TypedPhraseFieldProps): React.ReactElement {
  const phraseId = `${id}-phrase`;
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const [touched, setTouched] = useState(false);
  // An IME (Thai input methods too) holds a half-built value; judging it
  // would flash an error at every keystroke of a correct entry.
  const [composing, setComposing] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const reachedLength =
    normalizeTypedPhrase(value).length >= normalizeTypedPhrase(phrase).length;
  const showError =
    !composing &&
    value.length > 0 &&
    (touched || reachedLength) &&
    !typedPhraseMatches(value, phrase);

  async function onCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(phrase);
    } catch {
      return; // no clipboard (insecure context / denied) — typing still works
    }
    setCopied(true);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 3000);
  }

  const describedBy = [phraseId, helpText ? helpId : null, showError ? errorId : null]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {/* UX-C3 + U35: the WHOLE expected phrase as a copy target, wrapped in
          body type (a mono face has no Thai glyphs to fall back on). A 200
          character subject scrolls inside the cap; tabIndex keeps that
          scroll region reachable by keyboard. */}
      <p
        id={phraseId}
        tabIndex={0}
        className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded bg-muted px-2 py-1 text-sm leading-relaxed"
      >
        {phrase}
      </p>
      {copy ? (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-9"
            onClick={() => void onCopy()}
            disabled={disabled}
          >
            <CopyIcon className="size-3.5" aria-hidden />
            {copy.label}
          </Button>
          <span role="status" aria-live="polite" className="text-xs text-muted-foreground">
            {copied ? copy.copiedMessage : ''}
          </span>
        </div>
      ) : null}
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => setTouched(true)}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || onSubmit === undefined) return;
          if (composing || e.nativeEvent.isComposing) return;
          e.preventDefault();
          onSubmit();
        }}
        disabled={disabled}
        readOnly={readOnly}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        aria-invalid={showError}
        aria-describedby={describedBy}
      />
      {/* ux-standards § 4.1 — the error sits immediately under its input. */}
      {showError ? (
        <p id={errorId} className="text-xs text-destructive" role="alert">
          {errorMessage}
        </p>
      ) : null}
      {helpText ? (
        <p id={helpId} className="text-xs text-muted-foreground">
          {helpText}
        </p>
      ) : null}
    </div>
  );
}
