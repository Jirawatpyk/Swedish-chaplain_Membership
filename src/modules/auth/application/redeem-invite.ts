/**
 * redeem-invite use case (T124, spec US4 AS2).
 *
 * Invitee sets their initial password and activates the account.
 * Symmetric to `reset-password` but:
 *   - the account is `pending` (never active) before redemption
 *   - the invitation carries an `intendedRole` that MUST match the
 *     user's stored role (tamper detection: if an attacker somehow
 *     altered the user row after invitation, the redemption fails)
 *   - on success, we also create an initial session so the user
 *     lands signed in (contract §7 auto-sign-in behaviour)
 *
 * The "link-invalid" public slug covers the four underlying failures
 * (missing, consumed, expired, user state mismatch) to avoid leaking
 * which failure occurred.
 *
 * **Atomic redemption (A3 — Path C pattern, post-ship hardening 2026-05-17):**
 * Steps that mutate state (mark-consumed → set-password → activate →
 * create-session → audit) run inside a single `db.transaction`. Any
 * throw rolls back the whole batch.
 *
 *   `markInvitationConsumed` runs FIRST inside the tx. This mirrors
 *   `reset-password.ts` consume-then-set ordering (W-01) — if the
 *   surrounding tx commits, the token is dead; if it rolls back, the
 *   token is untouched and the user can retry. The pre-A3 code
 *   committed the password BEFORE consuming the token, opening a narrow
 *   replay window where an attacker holding the same token (T-15
 *   interception) could overwrite the legitimate user's just-set
 *   password.
 */
import { Result, err, ok } from '@/lib/result';
import { logger } from '@/lib/logger';
import { authMetrics } from '@/lib/metrics';
import { db } from '@/lib/db';
import type { InvitationTokenId } from '@/modules/auth/domain/branded';
import {
  classifyTokenFailure,
  isInvitationValid,
  type TokenFailureReason,
} from '@/modules/auth/domain/token';
import type { Session } from '@/modules/auth/domain/session';
import type { UserAccount } from '@/modules/auth/domain/user';
import { PORTAL_FOR_ROLE } from '@/modules/auth/domain/role';
import { portalHomePath } from '@/lib/portal-paths';
import {
  checkPasswordPolicy,
  type PasswordPolicyError,
} from '@/modules/auth/application/password-policy';
import { TxAbort } from '@/modules/auth/application/tx-abort';
// Type-only — see sign-in.ts for the Clean Architecture rationale.
import type { UserRepo } from '@/modules/auth/infrastructure/db/user-repo';
import type { TokenRepo } from '@/modules/auth/infrastructure/db/token-repo';
import type { SessionRepo } from '@/modules/auth/infrastructure/db/session-repo';
import type { AuditRepo } from '@/modules/auth/infrastructure/db/audit-repo';
import type { PasswordHasher } from '@/modules/auth/infrastructure/password/argon2-hasher';
import type { RateLimiter } from '@/modules/auth/infrastructure/rate-limit/upstash-rate-limiter';
import { retryAfterSeconds } from '@/modules/auth/application/rate-limit-retry';
import { defaultRedeemInviteDeps } from '@/lib/auth-deps';

// --- Public types -------------------------------------------------------------

export interface RedeemInviteInput {
  /**
   * Branded plaintext invitation token id. Route handler applies
   * `asInvitationTokenId()` after zod parsing. E2 — the repo hashes
   * this before any SQL lookup; the use case never sees the hash.
   */
  readonly token: InvitationTokenId;
  readonly password: string;
  readonly displayName?: string | null;
  readonly sourceIp: string;
  readonly requestId: string;
}

export interface RedeemInviteSuccess {
  readonly user: UserAccount;
  readonly session: Session;
  readonly redirectTo: string;
}

export type RedeemInviteError =
  | {
      /**
       * Public body stays uniform (`link-invalid`). The `reason`
       * discriminant is internal-only — it drives the audit summary
       * and the route handler's HTTP status (B1 — collapsed to 410 to
       * defeat enumeration via status-code probing).
       */
      readonly code: 'link-invalid';
      readonly reason: TokenFailureReason;
    }
  | {
      readonly code: 'weak-password';
      readonly errors: readonly PasswordPolicyError[];
    }
  | { readonly code: 'rate-limited'; readonly retryAfterSeconds: number };

// --- Tunables ----------------------------------------------------------------

const RATE_LIMIT_PER_IP = { max: 20, windowSeconds: 15 * 60 };

// --- Dependencies ------------------------------------------------------------

export interface RedeemInviteDeps {
  readonly users: UserRepo;
  readonly tokens: TokenRepo;
  readonly sessions: SessionRepo;
  readonly audit: AuditRepo;
  readonly hasher: PasswordHasher;
  readonly limiter: RateLimiter;
  readonly checkPolicy: typeof checkPasswordPolicy;
  readonly now: () => Date;
}

export { defaultRedeemInviteDeps };

// --- Use case ----------------------------------------------------------------

export async function redeemInvite(
  input: RedeemInviteInput,
  deps: RedeemInviteDeps = defaultRedeemInviteDeps,
): Promise<Result<RedeemInviteSuccess, RedeemInviteError>> {
  // 1. Rate limit (no DB writes yet — keep outside the tx).
  const ipLimit = await deps.limiter.check(
    `redeem:ip:${input.sourceIp}`,
    RATE_LIMIT_PER_IP.max,
    RATE_LIMIT_PER_IP.windowSeconds,
  );
  if (!ipLimit.success) {
    return err({
      code: 'rate-limited',
      retryAfterSeconds: retryAfterSeconds(ipLimit),
    });
  }

  // 2. Token lookup (pre-tx — failure path emits audit via the
  //    auto-swallowing `append`, not the tx-scoped variant).
  const now = deps.now();
  const invitation = await deps.tokens.findInvitationById(input.token);
  if (!invitation || !isInvitationValid(invitation, now)) {
    const reason = classifyTokenFailure(invitation);
    logger.warn(
      { requestId: input.requestId, reason },
      'redeem_invite.token_invalid',
    );
    if (invitation) {
      await deps.audit.append({
        eventType: 'invitation_redemption_failed',
        actorUserId: 'anonymous',
        targetUserId: invitation.userId,
        sourceIp: input.sourceIp,
        summary:
          reason === 'used' ? 'invitation already used' : 'invitation expired',
        requestId: input.requestId,
      });
      if (reason === 'used' || reason === 'expired') {
        authMetrics.invitationRedemptionFailed(reason);
      }
    }
    return err({ code: 'link-invalid', reason });
  }

  // 3. Password policy (pre-tx — pure compute + HIBP fetch).
  const policy = await deps.checkPolicy(input.password);
  if (!policy.ok) {
    return err({ code: 'weak-password', errors: policy.errors });
  }

  // 4. Hash the password BEFORE opening the tx — argon2id is CPU-bound
  //    (~100ms p50) and we don't want it holding a Neon connection
  //    open for the whole hash. Constitution VIII trade-off: a crash
  //    between hash + tx-open simply discards the hash; nothing
  //    persisted, user retries with no state drift.
  const hashed = await deps.hasher.hash(input.password);

  // 5. Atomic state transition (A3 — Path C).
  let outcome: { user: UserAccount; session: Session };
  try {
    outcome = await db.transaction(async (tx) => {
      // 5a. Consume token FIRST — mirrors W-01 ordering from
      //     reset-password. Replay-window defense in depth.
      await deps.tokens.markInvitationConsumedInTx(tx, input.token, now);

      // 5b. Re-read user inside the tx (locks the row).
      const user = await deps.users.findByIdInTx(tx, invitation.userId);
      if (
        !user ||
        user.status !== 'pending' ||
        user.role !== invitation.intendedRole
      ) {
        // Row state diverged after the pre-tx check — closer to 410
        // than 404, the link itself was once valid.
        throw new TxAbort<RedeemInviteError>({
          code: 'link-invalid',
          reason: 'used',
        });
      }

      // 5c. Set password + activate. Also persist the display name the
      //     invitee typed on the activation form: it arrives in the input
      //     (and the API body) but was previously dropped on the floor, so
      //     after activation the account rendered the raw email in the user
      //     menu instead of the entered name (BUG-022).
      await deps.users.setPasswordHashInTx(tx, user.id, hashed, now);
      await deps.users.activateInTx(tx, user.id, now);
      const trimmedDisplayName = input.displayName?.trim();
      if (trimmedDisplayName) {
        await deps.users.setDisplayNameInTx(tx, user.id, trimmedDisplayName);
      }

      // 5d. Initial session (auto sign-in).
      const session = await deps.sessions.createInTx(tx, {
        userId: user.id,
        sourceIp: input.sourceIp,
        now,
      });

      // 5e. Audit — also in-tx so the append-only row commits with
      //     the state change (Principle VIII / Path C).
      await deps.audit.appendInTx(tx, {
        eventType: 'sign_in_success',
        actorUserId: user.id,
        targetUserId: user.id,
        sourceIp: input.sourceIp,
        summary: 'invitation redeemed + initial session created',
        requestId: input.requestId,
      });

      // Activated user has status='active' + lastPasswordChangedAt=now;
      // construct the returned domain shape from the locked row without
      // a second read.
      const activated: UserAccount = {
        ...user,
        status: 'active',
        lastPasswordChangedAt: now,
        ...(trimmedDisplayName ? { displayName: trimmedDisplayName } : {}),
      };
      return { user: activated, session };
    });
  } catch (e) {
    if (e instanceof TxAbort) {
      return err(e.error as RedeemInviteError);
    }
    // Unexpected DB / network — surface as 500. Log so operators can
    // correlate with Neon dashboards.
    logger.error(
      { err: e, requestId: input.requestId },
      'redeem_invite.tx_failed',
    );
    throw e;
  }

  const redirectTo = portalHomePath(PORTAL_FOR_ROLE[outcome.user.role]);

  // Post-commit metric — counted only when the tx committed.
  authMetrics.invitationRedeemed(outcome.user.role);

  return ok({ user: outcome.user, session: outcome.session, redirectTo });
}
