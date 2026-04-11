/**
 * Sign-out use case (T069, spec FR-008).
 *
 * Idempotent: deleting a session that does not exist is treated as
 * success. The Route Handler (T071) always clears the cookie regardless
 * of the use case result.
 *
 * The use case owns the session-row lookup so the route handler
 * doesn't have to reach into `sessionRepo` directly (Clean Architecture
 * boundary: Presentation → Application → Infrastructure, never skip
 * the middle). Previously the route did the `findById` itself and
 * passed `userId` back into the use case as a type-lied `as never` —
 * both fixed here.
 */
import { Result, ok } from '@/lib/result';
import type { SessionId } from '@/modules/auth/domain/branded';
// Type-only — see sign-in.ts for the Clean Architecture rationale.
import type { SessionRepo } from '@/modules/auth/infrastructure/db/session-repo';
import type { AuditRepo } from '@/modules/auth/infrastructure/db/audit-repo';
import { defaultSignOutDeps } from '@/lib/auth-deps';

export interface SignOutInput {
  readonly sessionId: SessionId | null;
  readonly sourceIp: string;
  readonly requestId: string;
}

export interface SignOutDeps {
  readonly sessions: SessionRepo;
  readonly audit: AuditRepo;
}

export { defaultSignOutDeps };

export async function signOut(
  input: SignOutInput,
  deps: SignOutDeps = defaultSignOutDeps,
): Promise<Result<{ ok: true }, never>> {
  if (!input.sessionId) {
    // No cookie at all — nothing to delete, nothing to audit.
    return ok({ ok: true });
  }

  // Look up the session first so we can attribute the audit row to
  // the real userId — the sessionId alone is not enough. `findById`
  // may return null for stale cookies; that is not an error.
  const session = await deps.sessions.findById(input.sessionId);
  await deps.sessions.delete(input.sessionId);

  if (session) {
    await deps.audit.append({
      eventType: 'sign_out',
      actorUserId: session.userId,
      targetUserId: session.userId,
      sourceIp: input.sourceIp,
      summary: 'user signed out',
      requestId: input.requestId,
    });
  }

  return ok({ ok: true });
}
