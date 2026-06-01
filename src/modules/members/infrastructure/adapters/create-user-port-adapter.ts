/**
 * createUserPortAdapter — adapts F1 `createUser` to the narrowed `CreateUserPort`
 * the members invite use-cases (`invitePortal`, `bulkSendPortalInvite`) depend on.
 *
 * Single source of truth (go-live P1-17): the single-invite route AND the bulk
 * route both wire this ONE adapter via `buildMembersDeps`, so there is no
 * parallel copy of the F1-createUser glue to drift. The port constrains
 * `role` to `'member'` so admins cannot invite staff through these endpoints.
 *
 * Infrastructure layer — may import `@/modules/auth` (composition glue).
 */
import { createUser as f1CreateUser } from '@/modules/auth';
import type { CreateUserPort } from '../../application/use-cases/invite-portal';

export const createUserPortAdapter: CreateUserPort = async (input) => {
  const result = await f1CreateUser({
    email: input.email,
    role: input.role,
    displayName: input.displayName ?? null,
    // F1 createUser takes a branded UserId; at the boundary we pass the raw
    // session user id through. Safe because F1 itself re-brands.
    actorUserId: input.actorUserId as never,
    sourceIp: input.sourceIp,
    requestId: input.requestId,
    locale: input.locale,
    tenantId: input.tenantId,
  });
  if (result.ok) {
    return {
      ok: true,
      value: {
        user: { id: result.value.user.id },
        // Thread the queued-invite outbox row id through so the SAGA
        // compensation (go-live #12-13) can drop the dead invite on link failure.
        outboxRowId: result.value.outboxRowId,
      },
    };
  }
  return { ok: false, error: { code: result.error.code } };
};
