/**
 * 108 PR-D (US4 / US6 — FR-025, FR-030, FR-030b, FR-032, FR-053, FR-053a) —
 * switch a contact's marketing preference on or off.
 *
 * One use case behind BOTH toggles: staff (`actor.source = 'staff'`, gated by
 * `contacts.marketing` at the route) and the contact themself in the portal
 * (`'self'`, the route pins `contactId` to the session's own contact). Rules:
 *
 *   - OFF never consults the suppression list — there is nothing to protect.
 *   - ON refuses when the address is on the suppression list: the person's
 *     own unsubscribe always wins (FR-025) and staff cannot override it. ON
 *     also refuses when the list cannot be read — re-enabling blind would
 *     override an unsubscribe nobody checked (`suppression_unavailable`).
 *   - Same state → `unchanged`, no write, no audit (FR-030b idempotency —
 *     and the ORIGINAL actor + timestamp survive a repeated "off").
 *   - A removed contact has no marketing state → `not_found`.
 *   - The write and its audit row commit together; the audit payload is
 *     ids + `source` + the session role, never an address (FR-053a).
 *
 * Money emails are never affected by anything here (FR-033): delivery
 * eligibility is `isPrimary && removedAt === null` only.
 */
import { runInTenant } from '@/lib/db';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import {
  RECEIVES_MARKETING,
  type Contact,
  type ContactId,
  type MarketingOptOut,
  type MarketingOptOutSource,
} from '../../domain/contact';
import type { UserId } from '../../domain/value-objects/user-id';
import type { AuditPort, F3AuditEventType } from '../ports/audit-port';
import type { ContactRepo } from '../ports/contact-repo';
import type { MarketingSuppressionLookupPort } from '../ports/marketing-suppression-lookup-port';
import type { RepoError } from '../ports/member-repo';
import { UseCaseAbort } from '../tx-abort';

export type SetContactMarketingOptOutInput = {
  readonly contactId: ContactId;
  readonly state: 'on' | 'off';
  readonly actor: {
    readonly userId: string;
    /** The SESSION role, passed through verbatim (check:actor-role-truth). */
    readonly role: string;
    readonly source: MarketingOptOutSource;
  };
  readonly requestId: string;
};

export type SetContactMarketingOptOutDeps = {
  readonly tenant: TenantContext;
  readonly contactRepo: Pick<ContactRepo, 'findById' | 'setMarketingOptOutInTx'>;
  readonly audit: AuditPort;
  readonly marketingSuppression: MarketingSuppressionLookupPort;
  readonly clock?: { now(): Date };
};

export type SetContactMarketingOptOutError =
  | { readonly type: 'not_found' }
  /** FR-025 — the address is on the suppression list; "on" is refused. */
  | { readonly type: 'suppressed' }
  /** The suppression list could not be read; "on" is refused, not guessed. */
  | { readonly type: 'suppression_unavailable' }
  | { readonly type: 'server_error'; readonly message: string };

type MarketingAuditEvent = Extract<
  F3AuditEventType,
  'contact_marketing_opted_out' | 'contact_marketing_opted_in'
>;

export type SetContactMarketingOptOutOutcome =
  | {
      readonly outcome: 'changed';
      readonly contact: Contact;
      readonly event: MarketingAuditEvent;
    }
  | { readonly outcome: 'unchanged'; readonly contact: Contact };

export async function setContactMarketingOptOut(
  input: SetContactMarketingOptOutInput,
  deps: SetContactMarketingOptOutDeps,
): Promise<Result<SetContactMarketingOptOutOutcome, SetContactMarketingOptOutError>> {
  // 1. Pre-read (outside the tx): existence, liveness, and the address the
  //    suppression check needs. The state comparison itself happens under the
  //    row lock inside the tx, so this read is never the source of truth.
  const found = await deps.contactRepo.findById(deps.tenant, input.contactId);
  if (!found.ok) {
    if (found.error.code === 'repo.not_found') return err({ type: 'not_found' });
    return err({ type: 'server_error', message: `pre-read: ${found.error.code}` });
  }
  if (found.value.removedAt !== null) return err({ type: 'not_found' });

  // 2. FR-025 — "on" is refused for a suppressed address, and refused when the
  //    list cannot be read. "off" needs no check.
  if (input.state === 'on') {
    let suppressed: boolean;
    try {
      suppressed = await deps.marketingSuppression.isSuppressed(found.value.email);
    } catch {
      return err({ type: 'suppression_unavailable' });
    }
    if (suppressed) return err({ type: 'suppressed' });
  }

  const next: MarketingOptOut =
    input.state === 'off'
      ? {
          optedOutAt: (deps.clock ?? { now: () => new Date() }).now(),
          source: input.actor.source,
          byUserId: input.actor.userId as UserId,
        }
      : RECEIVES_MARKETING;
  const event: MarketingAuditEvent =
    input.state === 'off' ? 'contact_marketing_opted_out' : 'contact_marketing_opted_in';

  // 3. Write + audit in ONE tenant tx; a same-state row short-circuits with no
  //    audit (idempotent replays and double-clicks leave no trace).
  try {
    const outcome = await runInTenant(deps.tenant, async (tx) => {
      const written = await deps.contactRepo.setMarketingOptOutInTx(tx, input.contactId, next);
      if (!written.ok) throw new UseCaseAbort<RepoError>(written.error);
      if (written.value.outcome === 'unchanged') {
        return { outcome: 'unchanged' as const, contact: written.value.contact };
      }
      const audited = await deps.audit.recordInTx(tx, deps.tenant, {
        type: event,
        actorUserId: input.actor.userId,
        requestId: input.requestId,
        summary: `${event} for contact ${input.contactId}`,
        payload: {
          member_id: written.value.contact.memberId,
          contact_id: input.contactId,
          source: input.actor.source,
          actor_role: input.actor.role,
        },
      });
      if (!audited.ok) throw new UseCaseAbort<RepoError>(audited.error);
      return { outcome: 'changed' as const, contact: written.value.contact, event };
    });
    return ok(outcome);
  } catch (e) {
    if (e instanceof UseCaseAbort) {
      const re = e.error as RepoError;
      if (re.code === 'repo.not_found') return err({ type: 'not_found' });
      return err({ type: 'server_error', message: `set-marketing: ${re.code}` });
    }
    return err({ type: 'server_error', message: 'set-marketing: unexpected' });
  }
}
