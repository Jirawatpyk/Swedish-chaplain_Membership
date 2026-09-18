/**
 * F119 T032 — `EmailRendererPort`: the send-time wrapper as a port.
 *
 * `renderBroadcastHtml` (Infrastructure, `resend/email-template.ts`) is what
 * the Resend gateway feeds; the preview and the test copy MUST render
 * through the identical function (FR-042, FR-043, SC-011 — "preview vs
 * delivered email differ" is a defect). Application cannot import
 * Infrastructure, so the wrapper is reached through this port; the adapter
 * is a one-line binding in `resend/email-template-renderer.ts`.
 *
 * `bodyHtml` MUST already be sanitised by the caller; design blocks are
 * applied inside the wrapper, after sanitisation.
 */
import type { BrandSettings } from '../../domain/brand/brand-settings';

export type BroadcastRenderLocale = 'en' | 'th' | 'sv';

export interface RenderEmailInput {
  readonly subject: string;
  readonly bodyHtml: string;
  readonly tenantDisplayName: string;
  readonly locale: BroadcastRenderLocale;
  readonly brand: BrandSettings;
}

export interface EmailRendererPort {
  /** Full HTML document — header, body with blocks, footer with unsubscribe. */
  render(input: RenderEmailInput): string;
}
