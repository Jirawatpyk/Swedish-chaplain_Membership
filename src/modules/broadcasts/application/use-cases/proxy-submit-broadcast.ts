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
 * #18 (single member read): the calling route already loads the proxied
 * member once (for the DV-17 `companyName` → from-name). It passes the
 * outcome in via `memberLookup` so this use-case does NOT issue a second
 * `memberExistsInTenant` probe. The route maps its single
 * `drizzleMemberRepo.findById` to:
 *   - found       → { status: 'found', companyName }
 *   - repo.not_found → { status: 'not_found' }  → broadcast_member_not_found (404)
 *   - other error    → { status: 'lookup_failed', message } → submit.server_error (500)
 * preserving the not-found(404)/infra-throw(500) distinction without a
 * second round-trip.
 *
 * The proxied member's quota cap IS enforced inside `submitBroadcast`
 * (T-10); admin_proxy gets no free broadcast.
 *
 * The acting admin path runs `submitBroadcast`'s rate-limit precondition
 * (d) unchanged. Halt-state precondition (FR-002 k) STILL applies —
 * admin cannot bypass a member's halt flag (R3-NEW-1).
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

/**
 * Outcome of the route's single member read, threaded into the use-case
 * so it need not re-probe (#18). `companyName` only exists in the `found`
 * arm — the type forbids reading it otherwise.
 */
export type ProxyMemberLookup =
  | { readonly status: 'found'; readonly companyName: string }
  | { readonly status: 'not_found' }
  | { readonly status: 'lookup_failed'; readonly message: string };

export type ProxySubmitBroadcastError =
  | SubmitBroadcastError
  | { readonly kind: 'broadcast_member_not_found'; readonly memberId: string };

export type ProxySubmitBroadcastDeps = SubmitBroadcastDeps;

export interface ProxySubmitBroadcastInput {
  readonly proxiedMemberId: string;
  readonly adminUserId: string;
  readonly tenantDisplayName: string;
  /**
   * #18 — the proxied member read performed once by the route. The
   * `found` arm carries DV-17 `companyName` (F3) used by the delegated
   * `submitBroadcast` to compose `from_name` as
   * "<companyName> via <tenantDisplayName>" (data-model.md:59).
   */
  readonly memberLookup: ProxyMemberLookup;
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
  // #18 — consume the route's single member read instead of re-probing.
  switch (input.memberLookup.status) {
    case 'lookup_failed':
      // infra failure during the read → 500, never a misleading 422/404.
      return {
        ok: false,
        error: {
          kind: 'submit.server_error',
          message: `member_lookup_failed: ${input.memberLookup.message}`,
        },
      } as Result<ProxySubmitBroadcastOutput, ProxySubmitBroadcastError>;
    case 'not_found':
      return {
        ok: false,
        error: {
          kind: 'broadcast_member_not_found',
          memberId: input.proxiedMemberId,
        },
      } as Result<ProxySubmitBroadcastOutput, ProxySubmitBroadcastError>;
    case 'found':
      break;
  }

  const submitInput: SubmitBroadcastInput = {
    memberId: input.proxiedMemberId,
    submittedByUserId: input.adminUserId,
    actorRole: 'admin_proxy',
    tenantDisplayName: input.tenantDisplayName,
    memberDisplayName: input.memberLookup.companyName,
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
