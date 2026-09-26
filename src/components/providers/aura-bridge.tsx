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

/** 56px top bar (`--top-bar-height`) + 8px: the toast stack starts just below it. */
const TOASTER_OFFSET = 64;

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
      {/* The single toast surface for `@/lib/toast`: top-centre below the top bar
          (spec 122 decision). AURA's default Alt+T hotkey reaches the newest toast. */}
      <Toaster position="top-center" offset={TOASTER_OFFSET} />
    </AuraProvider>
  );
}

export interface AuraDensityProps {
  readonly density: 'compact' | 'comfortable';
  readonly children: React.ReactNode;
}

/**
 * Per-portal density (staff compact, member comfortable), inheriting the rest
 * from the bridge. Server layouts render this instead of importing
 * `AuraProvider` themselves: a server file importing AURA's barrel makes the
 * whole barrel a client reference, so every AURA component ships on every
 * route (measured +138 KB first-load JS); importing it here keeps the client
 * graph tree-shakeable.
 */
export function AuraDensity({ density, children }: AuraDensityProps): React.ReactElement {
  return <AuraProvider density={density}>{children}</AuraProvider>;
}
