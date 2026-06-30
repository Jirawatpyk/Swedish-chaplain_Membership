'use client';

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * FormErrorSummary — a focusable list of all validation errors, shown at the
 * top of a long form after a failed submit (ux-standards.md § 11.3 / § 7.3,
 * audit XF-09).
 *
 * Why: per-field inline errors below the fold are invisible on a long form
 * (e.g. the ~15-field member form). The GOV.UK error-summary pattern renders
 * one focusable region listing every error, each a link that jumps focus to
 * the offending field.
 *
 * Two valid integrations (pick one — see the `autoFocus` prop):
 *   - default (`autoFocus` true): the summary is the SINGLE focus target —
 *     pair it with react-hook-form `shouldFocusError:false` so the two don't
 *     race; on a fresh failed submit the region re-takes focus.
 *   - `autoFocus={false}`: keep RHF's default first-field focus (the pattern
 *     MemberForm uses); the summary still renders and announces via
 *     role="alert", it just doesn't grab focus.
 *
 * Renders nothing when there are no items.
 */
export interface FormErrorSummaryItem {
  /** DOM id of the input this error belongs to — used as the `#id` jump anchor. */
  readonly fieldId: string;
  /** Localised error message. */
  readonly message: string;
}

export interface FormErrorSummaryProps {
  /** Localised heading, e.g. "Please fix the following:". */
  readonly title: string;
  readonly items: readonly FormErrorSummaryItem[];
  readonly className?: string;
  /**
   * Take focus when the error set appears (default true — the GOV.UK pattern).
   * Pass false when the form already moves focus elsewhere on submit (e.g.
   * react-hook-form's `shouldFocusError` focuses the first field) so the two
   * don't fight; the summary still renders + announces via role="alert".
   */
  readonly autoFocus?: boolean;
}

export function FormErrorSummary({
  title,
  items,
  className,
  autoFocus = true,
}: FormErrorSummaryProps) {
  const ref = useRef<HTMLDivElement>(null);

  // A stable signature so the focus effect fires only when the actual error
  // set changes — not on every unrelated re-render (items is a fresh array
  // each render). Empty signature ⇒ no items ⇒ no focus.
  const signature = items.map((i) => `${i.fieldId}:${i.message}`).join('|');
  useEffect(() => {
    if (autoFocus && signature) ref.current?.focus();
  }, [autoFocus, signature]);

  if (items.length === 0) return null;

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      className={cn(
        'rounded-lg border border-destructive/40 bg-destructive/5 p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      <p className="text-sm font-medium text-destructive">{title}</p>
      <ul className="mt-2 list-disc space-y-1 ps-5 text-sm">
        {items.map((item) => (
          <li key={item.fieldId}>
            <a
              href={`#${item.fieldId}`}
              className="text-destructive underline underline-offset-2 hover:no-underline"
            >
              {item.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
