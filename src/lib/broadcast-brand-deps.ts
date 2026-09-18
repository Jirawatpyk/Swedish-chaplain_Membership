/**
 * F119 T027 — composition root for the chamber brand chrome (plan § III,
 * research R12).
 *
 * The one cross-module seam the brand surface has: the logo the email
 * header shows is the invoice logo (`tenant_invoice_settings.logo_blob_key`,
 * super-admin only). The broadcasts module must not import
 * `@/modules/invoicing/**` internals, so the `TenantLogoUrlPort` adapter is
 * composed HERE over the invoicing barrel's READ-only export
 * `getTenantLogoPublicUrl` — `src/lib/**` is the sanctioned composition
 * layer (precedents: `contact-marketing-deps.ts`,
 * `members-change-request-deps.ts`).
 *
 * `tests/contract/broadcasts/brand-cannot-write-invoice-logo.test.ts` walks
 * the import graph from every `settings.broadcasts` entry point and pins
 * that this is the ONLY invoicing export the broadcasts side reaches.
 *
 * Routes and the send-time renderer import from here; Application code
 * never reaches into `src/lib`.
 */
import { getTenantLogoPublicUrl } from '@/modules/invoicing';
// The shared TRANSACTIONAL sender (already the dispatcher's) — the test copy
// is synchronous through it and never touches the Broadcasts surface (V4).
// Reached through the auth composition root, not a deep import.
import { emailSender } from '@/lib/auth-deps';
import {
  dompurifySanitizer,
  drizzleBrandSettingsRepo,
  emailTemplateRenderer,
  f7AuditAdapter,
  type BroadcastsAuditPort,
  type BrandChromePort,
  type BrandSettingsRepo,
  type RenderBroadcastPreviewDeps,
  type SendTestCopyDeps,
  type TenantLogoUrlPort,
  type TestCopyMailerPort,
} from '@/modules/broadcasts';
import type { TenantSlug } from '@/modules/tenants';
import { resolveTenantDisplayName } from '@/lib/broadcasts-route-helpers';

export const tenantLogoUrlPort: TenantLogoUrlPort = {
  resolve(tenantId: TenantSlug): Promise<string | null> {
    return getTenantLogoPublicUrl(tenantId as unknown as string);
  },
};

export interface BrandSettingsDeps {
  readonly repo: BrandSettingsRepo;
  readonly audit: BroadcastsAuditPort;
  readonly logoUrl: TenantLogoUrlPort;
}

export function makeBrandSettingsDeps(): BrandSettingsDeps {
  return { repo: drizzleBrandSettingsRepo, audit: f7AuditAdapter, logoUrl: tenantLogoUrlPort };
}

/**
 * The live brand chrome a render needs (FR-041c — read at render time, never
 * frozen into a version): colour + address from the tenant's settings row,
 * logo URL from the invoice settings. Every miss is fail-soft `null`.
 */
export const brandChromePort: BrandChromePort = {
  async load(tenantId: TenantSlug) {
    const [record, logoUrl] = await Promise.all([
      drizzleBrandSettingsRepo.find(tenantId),
      tenantLogoUrlPort.resolve(tenantId),
    ]);
    return { primaryColor: record.primaryColor, postalAddress: record.postalAddress, logoUrl };
  },
};

/**
 * T032 — everything `renderBroadcastPreview` needs, plus the tenant display
 * name the wrapper prints (resolved per call, the way the dispatch factory
 * does it; a failed lookup degrades to the slug rather than refusing the
 * preview).
 */
export async function makeRenderBroadcastPreviewDeps(
  tenantId: string,
): Promise<RenderBroadcastPreviewDeps & { readonly tenantDisplayName: string }> {
  let tenantDisplayName: string;
  try {
    tenantDisplayName = await resolveTenantDisplayName(tenantId);
  } catch {
    tenantDisplayName = tenantId;
  }
  return {
    sanitizer: dompurifySanitizer,
    brand: brandChromePort,
    renderer: emailTemplateRenderer,
    tenantDisplayName,
  };
}

/** T105 — `TestCopyMailerPort` over the shared transactional sender. */
export const testCopyMailer: TestCopyMailerPort = {
  async send(message) {
    const r = await emailSender.send({ to: message.to, subject: message.subject, html: message.html });
    if (r.ok) return r;
    // The auth sender's error union is wider (it also names template faults);
    // the port only distinguishes "bad address" from "provider down".
    return {
      ok: false,
      error: {
        code: r.error.code === 'invalid-recipient' ? 'invalid-recipient' : 'upstream-unavailable',
        message: r.error.message,
      },
    };
  },
};

/** T105 — everything `sendTestCopy` needs, plus the tenant display name. */
export async function makeSendTestCopyDeps(
  tenantId: string,
): Promise<SendTestCopyDeps & { readonly tenantDisplayName: string }> {
  const preview = await makeRenderBroadcastPreviewDeps(tenantId);
  return {
    sanitizer: preview.sanitizer,
    brand: preview.brand,
    renderer: preview.renderer,
    mailer: testCopyMailer,
    audit: f7AuditAdapter,
    tenantDisplayName: preview.tenantDisplayName,
  };
}
