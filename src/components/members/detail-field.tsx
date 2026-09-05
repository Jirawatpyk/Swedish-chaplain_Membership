/**
 * Shared <Field> primitive for the admin member-detail page.
 *
 * 056 fix #7 — previously DUPLICATED in two places: an inline `Field` in
 * `[memberId]/page.tsx` (with a `fallback` prop) and a private `Field` in
 * `member-number-field.tsx` (value always present). This single component
 * is the one source of truth so the two never drift apart.
 *
 * Server- AND client-safe: imports only React + a `cn` util, so the client
 * `MemberNumberField` and the server detail page can both consume it.
 *
 * Renders a `<dt>`/`<dd>` pair — callers MUST wrap a group of <DetailField>s
 * in a `<dl>` so the description-list semantics are valid (WCAG 1.3.1).
 */

import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export interface DetailFieldProps {
  readonly label: string;
  readonly value: string | number | null | undefined;
  /** Shown (muted) when `value` is empty AND no `extra` is supplied. */
  readonly fallback?: string;
  /** Render the value in a monospace face (UUIDs, tax IDs, member numbers). */
  readonly mono?: boolean;
  /**
   * Trailing node rendered after the value — a copy button, a badge, a
   * country flag, an external-link, etc. Always renders even when `value`
   * is null, so it may be the SOLE content of the field.
   */
  readonly extra?: ReactNode;
  /**
   * Extra classes on the field's own root `<div>` (e.g. a grid `col-span`).
   * Use this instead of wrapping the field in another `<div>`: inside a
   * `<dl>` a wrapper makes `div > div > dt`, which fails axe's
   * `definition-list` / `dlitem` rules (108 PR-D portal a11y sweep).
   */
  readonly className?: string;
}

export function DetailField({
  label,
  value,
  fallback = '—',
  mono = false,
  extra,
  className,
}: DetailFieldProps) {
  const v =
    value === null || value === undefined || value === '' ? null : String(value);
  return (
    <div className={cn('flex flex-col gap-1 py-2', className)}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="flex items-center gap-2 text-sm">
        {v !== null && (
          <span className={cn(mono && 'font-mono text-xs')}>{v}</span>
        )}
        {v === null && extra === undefined && (
          <span className="text-muted-foreground">{fallback}</span>
        )}
        {extra}
      </dd>
    </div>
  );
}
