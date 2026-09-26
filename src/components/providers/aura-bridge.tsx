'use client';

/**
 * The one place AURA learns the user's language, calendar, time zone, router
 * link and density (spec 122 FR-005, contracts/aura-bridge.md), and the single
 * mount point of the product's toast surface.
 *
 * - Calendar: Buddhist Era for Thai, Gregorian otherwise — display only; stored
 *   dates stay ISO 8601 UTC, and product-formatted dates keep going through
 *   `@/lib/format-date-localised`.
 * - Built-in labels come from AURA's own EN/TH/SV strings, picked by `locale`.
 * - Density is set per portal by a nested `<AuraProvider density>` in the
 *   staff and member layouts; it inherits everything else from here.
 */
import Link from 'next/link';
import { AuraProvider, Toaster } from '@jirawatpyk/aura-react';

export interface AuraBridgeProps {
  readonly locale: 'en' | 'th' | 'sv';
  /** The tenant's IANA time zone, for "today" in AURA date and time pickers. */
  readonly timeZone: string;
  readonly children: React.ReactNode;
}

export function AuraBridge({ locale, timeZone, children }: AuraBridgeProps): React.ReactElement {
  return (
    <AuraProvider
      locale={locale}
      calendar={locale === 'th' ? 'buddhist' : 'gregory'}
      timeZone={timeZone}
      linkComponent={Link}
    >
      {children}
      {/* The single toast surface for `@/lib/toast`; top-centre per the spec 122 decision. */}
      <Toaster position="top" />
    </AuraProvider>
  );
}
