/**
 * WP5 — client-safe THB formatter.
 *
 * The plans-domain `formatMoney` (C-4) lives behind the server-heavy
 * `@/modules/plans` barrel and cannot be imported into a client component,
 * so the portal renewal price surfaces format through next-intl's
 * `useFormatter` instead. `currencyDisplay: 'narrowSymbol'` holds the ฿ in
 * every locale (C-12) — under `en` the default symbol display renders
 * "THB 5,000.00", which reads as a currency code, not money.
 *
 * The renewal domain is THB-only (`RenewalCycle.frozenPlanCurrency` is the
 * literal `'THB'`), so minor→major is `/100`.
 */
import type { useFormatter } from 'next-intl';

type NextIntlFormatter = ReturnType<typeof useFormatter>;

export function formatThbMinorUnits(
  format: NextIntlFormatter,
  minorUnits: number,
  options?: { readonly signDisplay?: 'exceptZero' },
): string {
  return format.number(minorUnits / 100, {
    style: 'currency',
    currency: 'THB',
    currencyDisplay: 'narrowSymbol',
    ...(options?.signDisplay ? { signDisplay: options.signDisplay } : {}),
  });
}
