'use client';

/**
 * Spec 122 US8c-2 (T858) — preview helpers for the invoice settings
 * (`/test-fixtures/aura-admin?view=invoice-settings&state=…`, board
 * `Admin-invoice-settings`): the dirty / prefix-confirm driver. The fixture
 * values live in `invoice-settings-fixtures.ts` (a server file can't read a
 * value exported from a client module). Nothing can save.
 */
import { useEffect, useRef, type ReactNode } from 'react';


/** Types into an input the way a user would, so React's onChange runs. */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * `dirty`: edits the short name so the save bar shows. `prefix-confirm`: edits
 * the invoice prefix and submits, so the §87 prefix-change confirmation opens.
 */
export function InvoiceSettingsPreviewDriver({
  action,
  children,
}: {
  readonly action: 'dirty' | 'prefix-confirm' | null;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!action) return;
    let tries = 0;
    const id = window.setInterval(() => {
      const root = ref.current;
      const field = root?.querySelector<HTMLInputElement>(action === 'dirty' ? '#brand_name' : '#inv_prefix');
      if (!field && ++tries < 50) return;
      window.clearInterval(id);
      if (!field) return;
      typeInto(field, action === 'dirty' ? 'SweCham Bangkok' : 'SCB');
      if (action === 'prefix-confirm') {
        window.setTimeout(() => field.form?.requestSubmit(), 50);
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [action]);
  // `contents` keeps the page's own column gaps (DetailContainer lays out its children).
  return (
    <div ref={ref} className="contents">
      {children}
    </div>
  );
}
