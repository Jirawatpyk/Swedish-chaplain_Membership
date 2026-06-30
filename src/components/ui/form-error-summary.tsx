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
 * the offending field. The consuming form should pass `shouldFocusError:false`
 * to react-hook-form so this summary is the single focus target instead of
 * RHF racing it to the first field.
 *
 * Renders nothing when there are no items. When the error set changes (a fresh
 * failed submit), the region re-takes focus so keyboard/SR users are always
 * delivered to the summary.
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
}

export function FormErrorSummary({
  title,
  items,
  className,
}: FormErrorSummaryProps) {
  const ref = useRef<HTMLDivElement>(null);

  // A stable signature so the focus effect fires only when the actual error
  // set changes — not on every unrelated re-render (items is a fresh array
  // each render). Empty signature ⇒ no items ⇒ no focus.
  const signature = items.map((i) => `${i.fieldId}:${i.message}`).join('|');
  useEffect(() => {
    if (signature) ref.current?.focus();
  }, [signature]);

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
