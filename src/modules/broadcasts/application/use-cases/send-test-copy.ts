/**
 * F119 T105 — `sendTestCopy` (FR-037; research R23).
 *
 * A test copy goes ONLY to the requesting user's own address, resolved by
 * the route from the session (a body-supplied address never reaches this
 * use case). It is marked as a test — the subject carries the localised
 * `[Test]` prefix — and runs the IDENTICAL pipeline as a real send: the
 * shared sanitiser policy, the design-block rules (FR-041 — a test that
 * would be refused at send is refused here), the live brand chrome, and
 * the SAME wrapper (`EmailRendererPort`). It changes nothing: no stage, no
 * version, no allowance — this use case has no port that could.
 *
 * ROUND-3 #10 — "IDENTICAL pipeline" is true of the STAGES and deliberately
 * NOT of the brand read's failure mode. Dispatch and the audience tick go
 * through `_load-brand-chrome.ts`, which degrades to no chrome and counts
 * `brandChromeUnavailable` — a send must not be lost over a logo. Here and in
 * `renderBroadcastPreview` the read is called directly, so a fault propagates
 * and the operator gets an error instead of an email. That asymmetry is the
 * point: the test copy exists to SHOW what will be sent, and a test copy that
 * quietly arrives unbranded teaches the operator the brand is broken at the
 * one moment they would otherwise have caught it.
 *
 * Synchronous through `TestCopyMailerPort` (the transactional sender):
 * the outcome is reported in-band, no outbox row exists. Audit
 * `broadcast_test_copy_sent { related_member_id, broadcast_id | null,
 * version_id | null, recipient_hash, actor_role }` — `related_member_id`
 * EVEN for a portal user (`contracts/dashboard-and-notifications.md` § 2):
 * a test copy to one's own inbox is not member activity on the E-Blast,
 * so it must NOT fire the 0009 `last_activity_at` trigger. The recipient
 * is hashed; the address never enters the audit trail.
 *
 * Pure Application — no framework imports.
 */
import { createHash } from 'node:crypto';
import { err, ok, type Result } from '@/lib/result';
import type { TenantSlug } from '@/modules/tenants';
import { parseBlockMarkers, validateBlocks, type BlockViolation } from '../../domain/design-blocks/block-markers';
import type { AuditPort } from '../ports/audit-port';
import type { BrandChromePort } from '../ports/brand-chrome-port';
import type { BroadcastRenderLocale, EmailRendererPort } from '../ports/email-renderer-port';
import type { HtmlSanitizerPort } from '../ports/html-sanitizer-port';
import type { TestCopyMailerError, TestCopyMailerPort } from '../ports/test-copy-mailer-port';

/** Same caps as a real send (`broadcasts_subject_length` / `_body_html_size`). */
export const TEST_COPY_SUBJECT_MAX = 200;
export const TEST_COPY_BODY_MAX_BYTES = 200 * 1024;

/**
 * The `[Test]` marker per locale — kept here (not in the message JSON) so a
 * missing key can never send an unmarked test copy: next-intl does not
 * throw on a missing key, and an unmarked test looks like a real send.
 */
export const TEST_COPY_SUBJECT_PREFIX: Readonly<Record<BroadcastRenderLocale, string>> = {
  en: '[Test] ',
  th: '[ทดสอบ] ',
  sv: '[Test] ',
};

export interface SendTestCopyDeps {
  readonly sanitizer: HtmlSanitizerPort;
  readonly brand: BrandChromePort;
  readonly renderer: EmailRendererPort;
  readonly mailer: TestCopyMailerPort;
  readonly audit: AuditPort;
}

export interface SendTestCopyInput {
  readonly tenantId: TenantSlug;
  readonly tenantDisplayName: string;
  readonly actorUserId: string;
  /** The session role, recorded as-is (`member` for a portal user), never a literal. */
  readonly actorRole: string | null;
  /** The session user's own address — the ONLY recipient. */
  readonly actorEmail: string;
  /** The member the E-Blast is FOR (the caller's member on the portal; null for staff without one). */
  readonly relatedMemberId: string | null;
  readonly broadcastId: string | null;
  readonly versionId: string | null;
  readonly requestId: string;
  readonly subject: string;
  readonly bodyHtml: string;
  readonly locale: BroadcastRenderLocale;
}

export type SendTestCopyError =
  | { readonly kind: 'invalid_body'; readonly reason: 'subject_too_long' | 'body_too_large' }
  | { readonly kind: 'content_rules'; readonly violations: readonly BlockViolation[] }
  | { readonly kind: 'sanitizer_unavailable'; readonly reason: string }
  | {
      readonly kind: 'mailer_unavailable';
      /**
       * The port's PII-free code (F7-5): `invalid-recipient` is a PERMANENT
       * refusal (Resend `validation_error` or `invalid_to_address` — the
       * address or the sending setup, F7-6) and must not answer "try again";
       * `upstream-unavailable` is an outage. `reason` is the provider's
       * verbatim text and is never logged.
       */
      readonly code: TestCopyMailerError['code'];
      readonly reason: string;
    };

export interface SendTestCopyOutput {
  readonly messageId: string;
}

function recipientHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex').slice(0, 16);
}

export async function sendTestCopy(
  deps: SendTestCopyDeps,
  input: SendTestCopyInput,
): Promise<Result<SendTestCopyOutput, SendTestCopyError>> {
  if (input.subject.length > TEST_COPY_SUBJECT_MAX) {
    return err({ kind: 'invalid_body', reason: 'subject_too_long' });
  }
  if (Buffer.byteLength(input.bodyHtml, 'utf8') > TEST_COPY_BODY_MAX_BYTES) {
    return err({ kind: 'invalid_body', reason: 'body_too_large' });
  }

  let sanitised: string;
  try {
    sanitised = deps.sanitizer.sanitize(input.bodyHtml);
  } catch (e) {
    return err({ kind: 'sanitizer_unavailable', reason: e instanceof Error ? e.message : String(e) });
  }
  if (Buffer.byteLength(sanitised, 'utf8') > TEST_COPY_BODY_MAX_BYTES) {
    return err({ kind: 'invalid_body', reason: 'body_too_large' });
  }
  // The identical content rules a real send applies (FR-004 / FR-041).
  const violations = validateBlocks(parseBlockMarkers(sanitised));
  if (violations.length > 0) {
    return err({ kind: 'content_rules', violations });
  }

  const brand = await deps.brand.load(input.tenantId);
  const subject = `${TEST_COPY_SUBJECT_PREFIX[input.locale]}${input.subject}`;
  const html = deps.renderer.render({
    subject,
    bodyHtml: sanitised,
    tenantDisplayName: input.tenantDisplayName,
    locale: input.locale,
    brand,
  });

  const sent = await deps.mailer.send({ to: input.actorEmail, subject, html });
  if (!sent.ok) {
    return err({ kind: 'mailer_unavailable', code: sent.error.code, reason: sent.error.message });
  }

  // No state change → no tenant tx; the adapter writes the row on autocommit.
  await deps.audit.emit(null, {
    eventType: 'broadcast_test_copy_sent',
    tenantId: input.tenantId,
    requestId: input.requestId,
    actorUserId: input.actorUserId,
    summary: 'E-Blast test copy sent to the requester',
    payload: {
      related_member_id: input.relatedMemberId,
      broadcast_id: input.broadcastId,
      version_id: input.versionId,
      recipient_hash: recipientHash(input.actorEmail),
      locale: input.locale,
      actor_role: input.actorRole ?? null,
    },
  });
  return ok({ messageId: sent.value.messageId });
}
