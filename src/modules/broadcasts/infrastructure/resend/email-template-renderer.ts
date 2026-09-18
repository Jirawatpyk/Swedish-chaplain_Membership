/**
 * F119 T032 — `EmailRendererPort` adapter: the ONE wrapper, bound as a port.
 *
 * Nothing but a pass-through to `renderBroadcastHtml` — the same function
 * the Resend gateway calls at send time — so the preview route, the test
 * copy and the delivered email cannot diverge (SC-011).
 */
import type { EmailRendererPort, RenderEmailInput } from '../../application/ports/email-renderer-port';
import { renderBroadcastHtml } from './email-template';

export const emailTemplateRenderer: EmailRendererPort = {
  render(input: RenderEmailInput): string {
    return renderBroadcastHtml(input);
  },
};
