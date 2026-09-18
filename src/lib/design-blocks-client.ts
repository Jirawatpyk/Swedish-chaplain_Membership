/**
 * F119 T089/T100/T102 — the client-safe slice of the design-block Domain.
 *
 * The alt-text dialog refuses a description outside 1–125 characters and the
 * CTA dialog refuses text outside 1–60 and a link off the scheme allow-list,
 * BEFORE the block can exist. Those are the same bounds `validateBlocks`
 * refuses with on the server (`domain/design-blocks/block-markers.ts`), and a
 * second copy in the browser would drift and start promising an insert the
 * submit then rejects.
 *
 * Why a `src/lib` re-export rather than a deep import from the component:
 * `src/lib/**` is the sanctioned composition layer (the one path the
 * cross-module barrel guard exempts), and this module reaches the Domain FILE
 * directly — never `@/modules/broadcasts`, whose barrel re-exports Drizzle
 * repos and would drag the whole infrastructure graph into the Client
 * Component browser bundle (108 PR-D incident). `src/lib/brand-settings-client.ts`
 * is the precedent.
 *
 * Everything below is a frozen number: no `next`, no ORM, nothing that touches
 * a request.
 */
export {
  BANNER_ALT_MIN,
  BANNER_ALT_MAX,
  CTA_TEXT_MIN,
  CTA_TEXT_MAX,
  CTA_MAX_PER_MESSAGE,
} from '@/modules/broadcasts/domain/design-blocks/block-markers';
