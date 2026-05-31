/**
 * F9 US2 — `ActorDirectory` adapter (binds to the auth-owned resolver).
 *
 * Resolves actor ids to identities via the auth PUBLIC BARREL
 * (`resolveActorIdentities`) — no deep/foreign-table imports (Principle III).
 */
import { resolveActorIdentities } from '@/modules/auth';
import type {
  ActorDirectory,
  ActorIdentityView,
} from '../../application/ports/actor-directory';

export const actorDirectoryAdapter: ActorDirectory = {
  async labelsFor(
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, ActorIdentityView>> {
    return resolveActorIdentities(ids);
  },
};
