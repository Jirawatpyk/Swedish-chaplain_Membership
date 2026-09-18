/**
 * F119 T032 — `renderBroadcastPreview` (research R11; FR-042, FR-043).
 *
 * The preview IS the email: the body goes through the shared sanitiser
 * policy, the tenant's brand chrome is read live, and the SAME wrapper the
 * sender feeds (`EmailRendererPort` → `renderBroadcastHtml`) produces the
 * full document the client shows in an `<iframe srcdoc>`. Both surfaces —
 * member compose and staff format / sign-off — call this one use case; the
 * routes differ only in their gate and in the `surface` label.
 *
 * Limits mirror `sanitizeHtml` (subject ≤ 200, body ≤ 200 KB after
 * sanitisation) so a preview can never show what a save would refuse. A
 * refusal emits no metric; a success emits the counter once and records the
 * duration (T122a). No audit event — a preview is not a state change.
 *
 * Pure Application — no framework imports.
 */
import { err, ok, type Result } from '@/lib/result';
import { broadcastsMetrics } from '@/lib/metrics';
import type { TenantSlug } from '@/modules/tenants';
import type { BrandChromePort } from '../ports/brand-chrome-port';
import type { BroadcastRenderLocale, EmailRendererPort } from '../ports/email-renderer-port';
import type { HtmlSanitizerPort } from '../ports/html-sanitizer-port';

/** Same caps as `sanitizeHtml` / `broadcasts_subject_length` / `broadcasts_body_html_size`. */
export const PREVIEW_SUBJECT_MAX = 200;
export const PREVIEW_BODY_MAX_BYTES = 200 * 1024;

export type PreviewSurface = 'member' | 'staff';

export interface RenderBroadcastPreviewDeps {
  readonly sanitizer: HtmlSanitizerPort;
  readonly brand: BrandChromePort;
  readonly renderer: EmailRendererPort;
}

export interface RenderBroadcastPreviewInput {
  readonly tenantId: TenantSlug;
  readonly tenantDisplayName: string;
  readonly subject: string;
  readonly bodyHtml: string;
  readonly locale: BroadcastRenderLocale;
  readonly surface: PreviewSurface;
}

export type RenderBroadcastPreviewError =
  | { readonly kind: 'invalid_body'; readonly reason: 'subject_too_long' | 'body_too_large' }
  | { readonly kind: 'sanitizer_unavailable'; readonly reason: string };

export interface RenderBroadcastPreviewOutput {
  readonly html: string;
}

export async function renderBroadcastPreview(
  deps: RenderBroadcastPreviewDeps,
  input: RenderBroadcastPreviewInput,
): Promise<Result<RenderBroadcastPreviewOutput, RenderBroadcastPreviewError>> {
  const started = Date.now();
  if (input.subject.length > PREVIEW_SUBJECT_MAX) {
    return err({ kind: 'invalid_body', reason: 'subject_too_long' });
  }
  // The raw body is bounded too: sanitising 10 MB to check it shrinks is
  // exactly the amplification the 30/min bucket exists to stop.
  if (Buffer.byteLength(input.bodyHtml, 'utf8') > PREVIEW_BODY_MAX_BYTES) {
    return err({ kind: 'invalid_body', reason: 'body_too_large' });
  }

  let sanitised: string;
  try {
    sanitised = deps.sanitizer.sanitize(input.bodyHtml);
  } catch (e) {
    return err({ kind: 'sanitizer_unavailable', reason: e instanceof Error ? e.message : String(e) });
  }
  if (Buffer.byteLength(sanitised, 'utf8') > PREVIEW_BODY_MAX_BYTES) {
    return err({ kind: 'invalid_body', reason: 'body_too_large' });
  }

  const brand = await deps.brand.load(input.tenantId);
  const html = deps.renderer.render({
    subject: input.subject,
    bodyHtml: sanitised,
    tenantDisplayName: input.tenantDisplayName,
    locale: input.locale,
    brand,
  });

  broadcastsMetrics.previewRendered(input.tenantId as unknown as string, input.surface);
  broadcastsMetrics.previewRenderMs(input.tenantId as unknown as string, Date.now() - started);
  return ok({ html });
}
