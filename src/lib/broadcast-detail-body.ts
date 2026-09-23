/**
 * ROUND-3 #2 — the one way a stored E-Blast body becomes a readable document.
 *
 * Both detail pages read a broadcast back: the member's
 * `/portal/broadcasts/[id]` and the staff `/admin/broadcasts/[id]`, which is
 * the approve / reject surface. The staff one used to re-sanitise the stored
 * body and inject it with `dangerouslySetInnerHTML`, so it showed a DIFFERENT
 * document from the one that ships — the design blocks and the tenant brand
 * are applied by `renderBroadcastHtml`, not by the sanitiser. Three text links
 * on the approver's screen, three brand-coloured buttons in the recipients'
 * inboxes; the sign-off was on content nobody receives.
 *
 * So both pages come through here, which drives the same server-side renderer
 * the preview route drives (`renderBroadcastPreview` → `applyDesignBlocks` +
 * brand + wrapper) and hands the result to the shared `PreviewSurface` —
 * a sandboxed `<iframe srcdoc>`, never the page's own DOM.
 *
 * Every failure degrades to the surface's translated error state. A brand-read
 * or sanitiser outage must not 404/500 a page whose subject, status and
 * delivery numbers are all still readable — and on the staff side the caller
 * additionally BLOCKS Approve on it: nobody signs off on a document the
 * server could not render.
 */
import type { PreviewState } from '@/components/broadcast/use-preview-html';
import { isLocale } from '@/i18n/config';
import { errKind } from '@/lib/log-id';
import { logger } from '@/lib/logger';
import { makeRenderBroadcastPreviewDeps } from '@/lib/broadcast-brand-deps';
import { renderBroadcastPreview } from '@/modules/broadcasts';

export interface RenderDetailBodyArgs {
  readonly tenantSlug: string;
  readonly broadcastId: string;
  readonly subject: string;
  readonly bodyHtml: string;
  readonly locale: string;
}

export async function renderBroadcastDetailBody(
  args: RenderDetailBodyArgs,
): Promise<PreviewState> {
  try {
    const { tenantDisplayName, ...deps } = await makeRenderBroadcastPreviewDeps(
      args.tenantSlug as never,
    );
    const result = await renderBroadcastPreview(deps, {
      tenantId: args.tenantSlug as never,
      tenantDisplayName,
      subject: args.subject,
      bodyHtml: args.bodyHtml,
      locale: isLocale(args.locale) ? args.locale : 'en',
      // ROUND-3 #11 — a detail read-back is neither the member's compose
      // preview nor the staff format pane; giving it its own label keeps the
      // preview counter's rate readable when a broadcast is opened a hundred
      // times after it is sent.
      surface: 'detail',
    });
    if (!result.ok) {
      logger.warn(
        {
          tenantId: args.tenantSlug,
          broadcastId: args.broadcastId,
          reason: result.error.kind,
        },
        'broadcasts.detail_page.body_render_failed',
      );
      return { status: 'error' };
    }
    return { status: 'ready', html: result.value.html };
  } catch (e) {
    logger.error(
      {
        err: errKind(e),
        tenantId: args.tenantSlug,
        broadcastId: args.broadcastId,
      },
      'broadcasts.detail_page.body_render_unexpected_error',
    );
    return { status: 'error' };
  }
}
