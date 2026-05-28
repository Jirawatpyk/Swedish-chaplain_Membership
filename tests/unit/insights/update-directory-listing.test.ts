/**
 * F9 US5 (T078) — `updateDirectoryListing` guard-branch unit tests.
 *
 * Covers the branches that short-circuit BEFORE `runInTenant` (no DB):
 *   - manager role → forbidden (read-only on the directory; FR-025)
 *   - member editing someone else's listing → forbidden
 *   - invalid website scheme → invalid_website (no write)
 *   - over-cap description → description_too_long (no write)
 * The happy path (upsert + audit + changed_fields) is covered by the live-Neon
 * integration test.
 */
import { describe, expect, it, vi } from 'vitest';
import { asTenantContext } from '@/modules/tenants';
import {
  updateDirectoryListing,
  type UpdateDirectoryListingDeps,
  type UpdateDirectoryListingInput,
  type UpdateDirectoryListingMeta,
} from '@/modules/insights/application/use-cases/update-directory-listing';
import type { DirectoryRepo } from '@/modules/insights/application/ports/directory-repo';

const ctx = asTenantContext('test-tenant');

function stubDeps(): UpdateDirectoryListingDeps {
  const directoryRepo: DirectoryRepo = {
    findByMemberIdInTx: vi.fn(),
    upsertInTx: vi.fn(),
    setLogoInTx: vi.fn(),
    search: vi.fn(),
    listPublishedInTx: vi.fn(),
  };
  return { directoryRepo, audit: { recordInTx: vi.fn(), record: vi.fn() } };
}

const baseInput: UpdateDirectoryListingInput = {
  memberId: 'm-1',
  listed: true,
  fieldVisibility: { name: true },
  industry: 'Manufacturing',
  description: 'We make widgets.',
  website: 'https://acme.example',
  locationCity: 'Bangkok',
  locationCountry: 'TH',
};

const memberMeta: UpdateDirectoryListingMeta = {
  actorUserId: 'u-1',
  actorRole: 'member',
  actorMemberId: 'm-1',
  requestId: 'req-1',
};

describe('updateDirectoryListing — guard branches', () => {
  it('forbids the read-only-on-finance manager from mutating a listing', async () => {
    const deps = stubDeps();
    const result = await updateDirectoryListing(
      baseInput,
      { ...memberMeta, actorRole: 'manager', actorMemberId: null },
      ctx,
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('forbidden');
    expect(deps.directoryRepo.upsertInTx).not.toHaveBeenCalled();
    expect(deps.audit.recordInTx).not.toHaveBeenCalled();
  });

  it("forbids a member editing another member's listing", async () => {
    const deps = stubDeps();
    const result = await updateDirectoryListing(
      { ...baseInput, memberId: 'm-2' },
      memberMeta, // actorMemberId = 'm-1'
      ctx,
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('forbidden');
    expect(deps.directoryRepo.upsertInTx).not.toHaveBeenCalled();
  });

  it('rejects a non-http(s) website scheme before any write', async () => {
    const deps = stubDeps();
    const result = await updateDirectoryListing(
      { ...baseInput, website: 'ftp://acme.example' },
      memberMeta,
      ctx,
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid_website');
    expect(deps.directoryRepo.upsertInTx).not.toHaveBeenCalled();
  });

  it('rejects an over-cap (>500 char) description before any write', async () => {
    const deps = stubDeps();
    const result = await updateDirectoryListing(
      { ...baseInput, description: 'a'.repeat(501) },
      memberMeta,
      ctx,
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('description_too_long');
    expect(deps.directoryRepo.upsertInTx).not.toHaveBeenCalled();
  });
});
