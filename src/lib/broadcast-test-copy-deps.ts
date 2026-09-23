/**
 * F119 T105 — composition root for the test copy (FR-037; research R23).
 *
 * Kept apart from `broadcast-brand-deps.ts` on purpose: the transactional
 * sender is reached through `@/lib/auth-deps`, which builds argon2 / Upstash
 * / repo singletons at module eval — the brand, preview and dispatch callers
 * must not pay for that (nor mock it) just to read a colour.
 */
import { emailSender } from '@/lib/auth-deps';
import { makeRenderBroadcastPreviewDeps } from '@/lib/broadcast-brand-deps';
import { f7AuditAdapter, type SendTestCopyDeps, type TestCopyMailerPort } from '@/modules/broadcasts';

/** `TestCopyMailerPort` over the shared transactional sender (never the Broadcasts surface). */
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

/** Everything `sendTestCopy` needs, plus the tenant display name. */
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
