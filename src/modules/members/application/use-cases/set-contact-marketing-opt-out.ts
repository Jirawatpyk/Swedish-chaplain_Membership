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
 *   - A contact's OWN opt-out (`source: 'self'`) is the same objection as the
 *     unsubscribe link (GDPR Art. 21(3) / PDPA §32 — FR-025 AMENDMENT,
 *     privacy review B-2): staff "on" over it → `self_opted_out`; only the
 *     contact lifts it. A self "off" over a STAFF record is a CHANGE — the
 *     objection is recorded (source becomes `self`) so no later staff action
 *     can silently override it; a staff "off" over a self record is
 *     `unchanged` (the person's record stays).
 *   - Same state → `unchanged`, no write, no audit (FR-030b idempotency —
 *     and the ORIGINAL actor + timestamp survive a repeated "off").
 *   - a contact ALREADY removed at the pre-read → `removed` (one removed in
 *     the window before the tx surfaces as `not_found`, and IS probe-audited);
 *     the route answers
 *     404 like `not_found`, but does NOT audit it as a cross-tenant probe —
 *     an in-tenant soft-deleted row is a benign race, security review LOW-1).
 *   - The write and its audit row commit together; the audit payload is
 *     ids + `source` + the session role, never an address (FR-053a). The
 *     member key is `member_id` ONLY for a self change: migration 0009's
 *     trigger bumps `members.last_activity_at` for any audit row carrying
 *     that key, and a STAFF action is not member activity (security review
 *     MEDIUM-1) — staff rows carry `related_member_id` instead (same key as
 *     0292; the member timeline COALESCEs both).
 *
 * Money emails are never affected by anything here (FR-033): delivery
 * eligibility is `isPrimary && removedAt === null` only.
 */
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import {
  type Contact,
  type ContactId,
  type MarketingOptOutSource,
} from '../../domain/contact';
import type { UserId } from '../../domain/value-objects/user-id';
import type { AuditPort, F3AuditEventType } from '../ports/audit-port';
import type { ContactRepo, SetMarketingCommand } from '../ports/contact-repo';
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
  readonly marketingSuppression: Pick<MarketingSuppressionLookupPort, 'isSuppressed'>;
  readonly clock?: { now(): Date };
};

export type SetContactMarketingOptOutError =
  | { readonly type: 'not_found' }
  /** An in-tenant contact that has been removed (soft-deleted) — 404, not a probe. */
  | { readonly type: 'removed' }
  /** FR-025 — the address is on the suppression list; "on" is refused. */
  | { readonly type: 'suppressed' }
  /** FR-025 AMENDMENT — the contact opted out themself; staff cannot lift it. */
  | { readonly type: 'self_opted_out' }
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
  if (found.value.removedAt !== null) return err({ type: 'removed' });

  // 2a. FR-025 AMENDMENT — a self opt-out is the person's objection; staff
  //     cannot lift it. Decided before the suppression lookup: the objection
  //     alone is sufficient, no external read needed. This is the FAST PATH;
  //     the repo re-checks the same rule on the LOCKED row (step 3), so a
  //     self opt-out committed after this read still wins.
  if (
    input.state === 'on' &&
    input.actor.source === 'staff' &&
    found.value.marketing.source === 'self'
  ) {
    return err({ type: 'self_opted_out' });
  }

  // 2b. FR-025 — "on" is refused for a suppressed address, and refused when
  //     the list cannot be read. "off" needs no check.
  if (input.state === 'on') {
    let suppressed: boolean;
    try {
      suppressed = await deps.marketingSuppression.isSuppressed(found.value.email);
    } catch {
      return err({ type: 'suppression_unavailable' });
    }
    if (suppressed) return err({ type: 'suppressed' });
  }

  const command: SetMarketingCommand =
    input.state === 'off'
      ? {
          kind: 'off',
          actor: input.actor.source,
          byUserId: input.actor.userId as UserId,
          at: (deps.clock ?? { now: () => new Date() }).now(),
        }
      : { kind: 'on', actor: input.actor.source };
  const event: MarketingAuditEvent =
    input.state === 'off' ? 'contact_marketing_opted_out' : 'contact_marketing_opted_in';

  // 3. Write + audit in ONE tenant tx; a same-state row short-circuits with no
  //    audit (idempotent replays and double-clicks leave no trace).
  try {
    const outcome = await runInTenant(deps.tenant, async (tx) => {
      const written = await deps.contactRepo.setMarketingOptOutInTx(tx, input.contactId, command);
      if (!written.ok) throw new UseCaseAbort<RepoError>(written.error);
      if (written.value.outcome === 'refused_self_opted_out') {
        // Nothing was written; the tx has nothing to roll back.
        return { outcome: 'refused_self_opted_out' as const };
      }
      if (written.value.outcome === 'unchanged') {
        return { outcome: 'unchanged' as const, contact: written.value.contact };
      }
      const audited = await deps.audit.recordInTx(tx, deps.tenant, {
        type: event,
        actorUserId: input.actor.userId,
        requestId: input.requestId,
        summary: `${event} for contact ${input.contactId}`,
        payload: {
          // `member_id` bumps `members.last_activity_at` (migration 0009) —
          // wanted ONLY when the contact acted themself. A staff action is
          // not member activity: `related_member_id` keeps the row on the
          // member timeline without touching recency (security MEDIUM-1).
          ...(input.actor.source === 'self'
            ? { member_id: written.value.contact.memberId }
            : { related_member_id: written.value.contact.memberId }),
          contact_id: input.contactId,
          source: input.actor.source,
          actor_role: input.actor.role,
        },
      });
      if (!audited.ok) throw new UseCaseAbort<RepoError>(audited.error);
      return { outcome: 'changed' as const, contact: written.value.contact, event };
    });
    if (outcome.outcome === 'refused_self_opted_out') return err({ type: 'self_opted_out' });
    return ok(outcome);
  } catch (e) {
    // Keep the CLASS of what actually failed (review errors HIGH-2): the repo
    // hands us `{ code, cause }` and the caller used to see only the code, so
    // a statement timeout, an RLS refusal and a violated 0294 CHECK were one
    // indistinguishable `repo.unexpected` in the logs.
    if (e instanceof UseCaseAbort) {
      const re = e.error as RepoError;
      if (re.code === 'repo.not_found') return err({ type: 'not_found' });
      logger.error(
        { requestId: input.requestId, err: re.code, cause: errKind('cause' in re ? re.cause : undefined) },
        'members.set_contact_marketing.repo_failed',
      );
      return err({ type: 'server_error', message: `set-marketing: ${re.code}` });
    }
    logger.error(
      { requestId: input.requestId, err: errKind(e) },
      'members.set_contact_marketing.unexpected',
    );
    return err({ type: 'server_error', message: 'set-marketing: unexpected' });
  }
}
