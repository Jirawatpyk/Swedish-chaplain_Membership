/**
 * Sign-out use case (T069, spec FR-008).
 *
 * Idempotent: deleting a session that does not exist is treated as
 * success. The Route Handler (T071) always clears the cookie regardless
 * of the use case result.
 */
import { Result, ok } from '@/lib/result';
import type { SessionId, UserId } from '@/modules/auth/domain/branded';
import { sessionRepo, type SessionRepo } from '@/modules/auth/infrastructure/db/session-repo';
import { auditRepo, type AuditRepo } from '@/modules/auth/infrastructure/db/audit-repo';

export interface SignOutInput {
  readonly sessionId: SessionId | null;
  readonly userId: UserId | null;
  readonly sourceIp: string;
  readonly requestId: string;
}

export interface SignOutDeps {
  readonly sessions: SessionRepo;
  readonly audit: AuditRepo;
}

const defaultDeps: SignOutDeps = {
  sessions: sessionRepo,
  audit: auditRepo,
};

export async function signOut(
  input: SignOutInput,
  deps: SignOutDeps = defaultDeps,
): Promise<Result<{ ok: true }, never>> {
  if (input.sessionId) {
    await deps.sessions.delete(input.sessionId);
  }
  if (input.userId) {
    await deps.audit.append({
      eventType: 'sign_out',
      actorUserId: input.userId,
      targetUserId: input.userId,
      sourceIp: input.sourceIp,
      summary: 'user signed out',
      requestId: input.requestId,
    });
  }
  return ok({ ok: true });
}
