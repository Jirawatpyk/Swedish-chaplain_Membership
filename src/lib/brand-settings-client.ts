/**
 * F119 T030 — the client-safe slice of the brand Domain.
 *
 * The Brand page's colour field shows a LIVE contrast readout and disables
 * Save below WCAG AA, so the browser needs the same arithmetic and the same
 * `#RRGGBB` parser the server refuses with — a second copy of either would
 * drift and start promising a save the API then rejects.
 *
 * Why a `src/lib` re-export rather than a deep import from the component:
 * `src/lib/**` is the sanctioned composition layer (it is the one path the
 * cross-module barrel guard in `eslint.config.mjs` exempts), and this module
 * reaches the Domain FILES directly — never `@/modules/broadcasts`, whose
 * barrel re-exports Drizzle repos and would drag the whole infrastructure
 * graph into the Client Component browser bundle (108 PR-D incident).
 *
 * Everything below is framework-free arithmetic and string parsing: no
 * `next`, no ORM, nothing that touches a request.
 */
export {
  AA_MIN_CONTRAST,
  contrastRatioOnWhite,
  meetsAaOnWhiteText,
} from '@/modules/broadcasts/domain/brand/contrast';
export {
  BRAND_POSTAL_ADDRESS_MAX,
  DEFAULT_BRAND_PRIMARY_COLOR,
  parseBrandPrimaryColor,
} from '@/modules/broadcasts/domain/brand/brand-settings';
