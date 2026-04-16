/**
 * `directory-search` use case (T062, US2).
 *
 * Thin wrapper over `searchDirectory` in the member-repo module so the
 * Application layer doesn't expose raw Infrastructure types to
 * Presentation. Pagination uses opaque base64 cursors — callers treat
 * them as opaque tokens and echo back.
 *
 * SC-002: substring p95 < 500 ms on 5,000-row tenants — backed by
 * pg_trgm GIN indexes from migration 0009.
 */

import { ok, err, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type {
  DirectoryFilter,
  DirectoryRow,
  MemberRepo,
} from '../ports/member-repo';

export type DirectorySearchInput = Omit<DirectoryFilter, 'limit' | 'cursor'> & {
  readonly limit?: number;
  readonly cursor?: string;
};

export type DirectorySearchOutput = {
  readonly items: readonly DirectoryRow[];
  readonly nextCursor: string | null;
};

export type DirectorySearchError =
  | { type: 'server_error'; message: string };

export type DirectorySearchDeps = {
  tenant: TenantContext;
  memberRepo: MemberRepo;
};

export async function directorySearch(
  deps: DirectorySearchDeps,
  input: DirectorySearchInput,
): Promise<Result<DirectorySearchOutput, DirectorySearchError>> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const result = await deps.memberRepo.searchDirectory(deps.tenant, {
    ...input,
    limit,
  } as DirectoryFilter);
  if (!result.ok)
    return err({
      type: 'server_error',
      message: `directory: ${result.error.code}`,
    });
  return ok(result.value);
}

// Re-export types from the port for consumers
export type { DirectoryRow, DirectoryFilter } from '../ports/member-repo';
