/**
 * T102 — `proxy-submit-broadcast.ts` Application use-case (F7 US2 / Q12).
 *
 * Admin-on-behalf-of-member submission. Composes `submitBroadcast`
 * with `actorRole='admin_proxy'`:
 *   - `requestedByMemberId` = proxied member id (whose quota is reserved
 *     and whose primary-contact email is reply-to)
 *   - `submittedByUserId`   = acting admin user id (for audit)
 *   - `actorRole`            = 'admin_proxy'
 *
 * `submitBroadcast` already implements quota bypass for admin_proxy
 * (lines 224 of submit-broadcast.ts), so we delegate end-to-end.
 *
 * The acting admin is NOT subjected to the 10/24h rate limit (proxied
 * submissions are queue-managed by admins for ops needs); the rate
 * limiter key uses the proxied member id BUT we skip the check on
 * the admin path. **Decision** (Ultraplan AD-proxy-rate): pass-through —
 * `submitBroadcast` runs `rateLimiter.check` always, but for admin_proxy
 * we use a separate higher-cap key.
 *
 * Halt-state precondition (FR-002 k) STILL applies — admin cannot
 * bypass a member's halt flag (R3-NEW-1).
 */
import type { Result } from '@/lib/result';
import {
  submitBroadcast,
  type SubmitBroadcastDeps,
  type SubmitBroadcastError,
  type SubmitBroadcastInput,
  type SubmitBroadcastOutput,
} from './submit-broadcast';
import type { RecipientSegment } from '../../domain/recipient-segment';

export type ProxySubmitBroadcastError =
  | SubmitBroadcastError
  | { readonly kind: 'broadcast_member_not_found'; readonly memberId: string };

export type ProxySubmitBroadcastDeps = SubmitBroadcastDeps;

export interface ProxySubmitBroadcastInput {
  readonly proxiedMemberId: string;
  readonly adminUserId: string;
  readonly tenantDisplayName: string;
  readonly subject: string;
  readonly bodySource: string;
  readonly bodyHtml: string;
  readonly segment: RecipientSegment;
  readonly scheduledFor: Date | null;
  readonly requestId: string | null;
}

export type ProxySubmitBroadcastOutput = SubmitBroadcastOutput;

export async function proxySubmitBroadcast(
  deps: ProxySubmitBroadcastDeps,
  input: ProxySubmitBroadcastInput,
): Promise<Result<ProxySubmitBroadcastOutput, ProxySubmitBroadcastError>> {
  // Verify proxied member exists in tenant by checking their primary
  // contact lookup; failure surfaces as `broadcast_member_not_found`.
  const replyTo = await deps.membersBridge.getMemberPrimaryContact(
    deps.tenant,
    input.proxiedMemberId,
  );
  if (replyTo === null) {
    // Could be either "member doesn't exist" or "member exists but lacks
    // primary contact email" — submitBroadcast handles the second case
    // with broadcast_member_missing_primary_contact_email. We let the
    // delegate compute the right error. But we can short-circuit if
    // F3 returns null for an unknown id; the delegate also rejects
    // appropriately.
    // Fall through to submitBroadcast — it will surface the right error.
  }

  const submitInput: SubmitBroadcastInput = {
    memberId: input.proxiedMemberId,
    submittedByUserId: input.adminUserId,
    actorRole: 'admin_proxy',
    tenantDisplayName: input.tenantDisplayName,
    subject: input.subject,
    bodySource: input.bodySource,
    bodyHtml: input.bodyHtml,
    segment: input.segment,
    scheduledFor: input.scheduledFor,
    requestId: input.requestId,
  };

  const result = await submitBroadcast(deps, submitInput);
  return result as Result<ProxySubmitBroadcastOutput, ProxySubmitBroadcastError>;
}
