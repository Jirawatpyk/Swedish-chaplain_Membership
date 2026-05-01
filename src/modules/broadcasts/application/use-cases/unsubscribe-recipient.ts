/**
 * T142 — `unsubscribe-recipient.ts` Application use-case (F7 US4).
 *
 * Recipient one-click unsubscribe + tenant-scoped suppression
 * (FR-029–FR-032). Called by the public `/unsubscribe/[token]` route
 * AFTER the route has:
 *   1. Peeked the token's tenant id (pre-tenant) via `peekTokenTenantId`
 *   2. Bound the RLS context with `runInTenant(tenant, ...)`
 *   3. Verified the HMAC under the bound tenant via
 *      `unsubscribeTokenSigner.verify(token)` and obtained `payload`.
 *
 * The use-case itself does NOT verify the token (that happens at the
 * route boundary so the verifier can run as early as possible —
 * recipient never reaches the use-case if the token is forged). It
 * picks up at the post-verify boundary and performs the idempotent
 * upsert + audit emit + member-id resolution.
 *
 * Idempotency contract (FR-030):
 *   - First valid click → suppression row inserted + `broadcast_unsubscribed`
 *     audit emitted → returns `{wasNew: true}`.
 *   - Subsequent valid clicks → no row mutation + no audit re-emit →
 *     returns `{wasNew: false}` so the page renders "Already unsubscribed".
 *   - Invalid-token clicks NEVER reach this use-case; the route emits
 *     `broadcast_unsubscribe_token_invalid` directly.
 *
 * Pure Application — only Domain types + ports.
 */
import { err, ok, type Result } from '@/lib/result';
import { sha256Hex } from '@/lib/crypto';
import { logger } from '@/lib/logger';
import type { TenantContext } from '@/modules/tenants';

import type { BroadcastId } from '../../domain/broadcast';
import type { EmailLower } from '../../domain/value-objects/email-lower';

import type { AuditPort } from '../ports/audit-port';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';
import type { MarketingUnsubscribesRepo } from '../ports/marketing-unsubscribes-repo';
import type { MembersBridgePort } from '../ports/members-bridge-port';
import type { ClockPort } from '../ports/clock-port';

export interface UnsubscribeRecipientInput {
  readonly tenantId: string;
  readonly broadcastId: BroadcastId;
  readonly emailLower: EmailLower;
  /** Raw token plaintext — hashed by this use-case before persisting. */
  readonly tokenPlaintext: string;
  readonly requestId: string | null;
  /** Optional recipient feedback box content (≤500 chars). MVP: always null. */
  readonly reasonText: string | null;
}

export interface UnsubscribeRecipientOutput {
  /** True on first unsubscribe; false on idempotent replay. */
  readonly wasNew: boolean;
  /** Display name of the tenant for the confirmation page. */
  readonly tenantDisplayName: string;
  /** Support contact email rendered on every confirmation/fallback page. */
  readonly tenantSupportEmail: string;
  readonly unsubscribedAt: Date;
}

export type UnsubscribeRecipientError =
  | {
      readonly kind: 'unsubscribe.broadcast_not_found';
      readonly broadcastId: BroadcastId;
    }
  | {
      readonly kind: 'unsubscribe.tenant_mismatch';
      readonly broadcastId: BroadcastId;
    }
  | {
      readonly kind: 'unsubscribe.repo_error';
      readonly cause: unknown;
    };

export interface UnsubscribeRecipientDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: BroadcastsRepo;
  readonly marketingUnsubscribes: MarketingUnsubscribesRepo;
  readonly membersBridge: MembersBridgePort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  /** Tenant display info — passed in from composition root or inline. */
  readonly tenantDisplayName: string;
  readonly tenantSupportEmail: string;
}

const REASON_TEXT_MAX = 500;

export async function unsubscribeRecipient(
  deps: UnsubscribeRecipientDeps,
  input: UnsubscribeRecipientInput,
): Promise<Result<UnsubscribeRecipientOutput, UnsubscribeRecipientError>> {
  // Tenant invariant: the route resolves tenant from the token then
  // binds RLS; this use-case takes the matching `tenant` ctx from deps.
  // Any mismatch between input.tenantId and deps.tenant is a programmer
  // error, not a runtime case — but we guard defensively because the
  // wrong context would let an unsubscribe target the wrong tenant's row.
  if (deps.tenant.slug !== input.tenantId) {
    return err({
      kind: 'unsubscribe.tenant_mismatch',
      broadcastId: input.broadcastId,
    });
  }

  const reasonText =
    input.reasonText === null
      ? null
      : input.reasonText.length > REASON_TEXT_MAX
        ? input.reasonText.slice(0, REASON_TEXT_MAX)
        : input.reasonText;

  const tokenHash = sha256Hex(input.tokenPlaintext);

  return deps.broadcastsRepo.withTx(async (tx) => {
    // Best-effort: confirm the broadcast exists in this tenant. We do
    // NOT fail the unsubscribe if the broadcast was hard-deleted (e.g.
    // GDPR Art. 17 cascade) — the recipient still has the right to
    // object indefinitely. We just won't have a `source_broadcast_id`
    // foreign-key value (NULL'd out below).
    let sourceBroadcastId: BroadcastId | null = null;
    try {
      const broadcast = await deps.broadcastsRepo.findByIdInTx(
        tx,
        input.tenantId,
        input.broadcastId,
      );
      if (broadcast !== null) sourceBroadcastId = broadcast.broadcastId;
    } catch (cause) {
      logger.warn(
        { broadcastId: input.broadcastId, err: (cause as Error).message },
        'unsubscribe_broadcast_lookup_failed',
      );
      // Continue — the suppression upsert + audit MUST still happen.
    }

    // Best-effort member resolution: if the recipient is a known member
    // we link the suppression to them (helps GDPR Art. 17 cascade later).
    let memberId: string | null = null;
    try {
      const m = await deps.membersBridge.lookupMemberPrimaryContactEmailInTenant(
        deps.tenant,
        input.emailLower,
      );
      if (m !== null) memberId = m.memberId;
    } catch (cause) {
      logger.warn(
        { err: (cause as Error).message },
        'unsubscribe_member_lookup_failed',
      );
      // Continue with memberId=null.
    }

    let upsertResult: Awaited<ReturnType<MarketingUnsubscribesRepo['upsert']>>;
    try {
      upsertResult = await deps.marketingUnsubscribes.upsert(tx, {
        tenantId: input.tenantId,
        emailLower: input.emailLower,
        memberId,
        reason: 'recipient_initiated',
        reasonText,
        sourceBroadcastId,
        sourceTokenHash: tokenHash,
      });
    } catch (cause) {
      return err({ kind: 'unsubscribe.repo_error', cause });
    }

    // Audit emit — only on first (idempotent replays MUST NOT
    // re-audit, per FR-030).
    if (upsertResult.wasNew) {
      try {
        await deps.audit.emit(tx, {
          eventType: 'broadcast_unsubscribed',
          actorUserId: 'system:public_unsubscribe',
          summary: `Recipient unsubscribed from broadcast ${input.broadcastId}`,
          payload: {
            broadcastId: sourceBroadcastId,
            emailHash: sha256Hex(`${input.tenantId}:${input.emailLower}`),
            memberId,
            sourceTokenHash: tokenHash,
            reason: 'recipient_initiated',
          },
          tenantId: input.tenantId,
          requestId: input.requestId,
        });
        await deps.audit.emit(tx, {
          eventType: 'broadcast_suppression_applied',
          actorUserId: 'system:public_unsubscribe',
          summary: `Suppression applied for ${sha256Hex(`${input.tenantId}:${input.emailLower}`).slice(0, 12)} (recipient_initiated)`,
          payload: {
            broadcastId: sourceBroadcastId,
            emailHash: sha256Hex(`${input.tenantId}:${input.emailLower}`),
            memberId,
            reason: 'recipient_initiated',
          },
          tenantId: input.tenantId,
          requestId: input.requestId,
        });
      } catch (cause) {
        // Audit failure during a successful suppression is observable
        // but MUST NOT roll back the suppression row — GDPR Art. 21
        // overrides operational signal loss.
        logger.error(
          { err: (cause as Error).message, broadcastId: sourceBroadcastId },
          'unsubscribe_audit_emit_failed_post_upsert',
        );
      }
    }

    return ok({
      wasNew: upsertResult.wasNew,
      tenantDisplayName: deps.tenantDisplayName,
      tenantSupportEmail: deps.tenantSupportEmail,
      unsubscribedAt: upsertResult.suppression.unsubscribedAt,
    });
  });
}
