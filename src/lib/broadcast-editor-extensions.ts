/**
 * F119 T088/T098/T102 — the client-safe slice of the broadcasts Tiptap
 * infrastructure.
 *
 * The writing tool is a Client Component, so it cannot import
 * `@/modules/broadcasts`: that barrel re-exports Drizzle repos and would drag
 * the whole infrastructure graph into the browser bundle (108 PR-D incident).
 * It also must not deep-import `@/modules/broadcasts/infrastructure/**`
 * directly — the barrel guard (`tests/unit/architecture/broadcasts-barrel.test.ts`)
 * forbids new deep imports from `src/components/**`.
 *
 * `src/lib/**` is the sanctioned composition layer and the one path that guard
 * exempts, so the four Tiptap node/extension configs are re-exported here and
 * the editor imports THEM. `src/lib/brand-settings-client.ts` (F119 T030) is
 * the precedent for this shape.
 *
 * Each re-exported module is browser-safe on its own: `@tiptap/core`,
 * `@tiptap/extension-image`, `@tiptap/pm` and the import-free shared content
 * policy. Nothing here touches a request, an ORM or `server-only`.
 */
export { broadcastImageExtension } from '@/modules/broadcasts/infrastructure/tiptap-image-extension-config';
export { broadcastBracketPlaceholderExtension } from '@/modules/broadcasts/infrastructure/tiptap-bracket-placeholder-config';
export { broadcastCtaButtonExtension } from '@/modules/broadcasts/infrastructure/tiptap-cta-button-config';
export { broadcastBannerImageExtension } from '@/modules/broadcasts/infrastructure/tiptap-banner-image-config';
export type { CtaButtonAttributes } from '@/modules/broadcasts/infrastructure/tiptap-cta-button-config';
export type { BannerImageAttributes } from '@/modules/broadcasts/infrastructure/tiptap-banner-image-config';
