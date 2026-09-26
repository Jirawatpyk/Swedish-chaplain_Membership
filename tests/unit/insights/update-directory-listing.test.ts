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

// The primary-contact gate reads the stored listing INSIDE the tx — run the
// callback against a fake tx so the gate is testable without a DB.
vi.mock('@/lib/db', () => ({
  runInTenant: (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({ fake: 'tx' }),
}));
vi.mock('@/lib/metrics', () => ({
  insightsMetrics: { directoryListingUpdated: vi.fn() },
}));
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
    findByMemberId: vi.fn(),
    upsertInTx: vi.fn(),
    setLogoInTx: vi.fn(),
    deleteForMemberInTx: vi.fn(),
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
  actorIsPrimaryContact: true,
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

// GDPR Art. 6 / PDPA §19 · §24 — the contact name + email the directory
// publishes are the LIVE primary contact's. Only that person may decide to
// publish them; a colleague may still edit every company field.
describe('updateDirectoryListing — primary-contact gate on the personal-data toggles', () => {
  const stored = {
    memberId: 'm-1',
    listed: true,
    fieldVisibility: { name: true, contact_name: true, contact_email: false },
    industry: 'Manufacturing',
    description: null,
    website: null,
    logoUrl: null,
    locationCity: null,
    locationCountry: null,
    contactVisibilitySetByContactId: 'c-primary',
  };
  const colleague: UpdateDirectoryListingMeta = { ...memberMeta, actorIsPrimaryContact: false };

  function depsWithStored(): UpdateDirectoryListingDeps {
    const deps = stubDeps();
    vi.mocked(deps.directoryRepo.findByMemberIdInTx).mockResolvedValue(stored);
    vi.mocked(deps.directoryRepo.upsertInTx).mockResolvedValue({ memberNotFound: false });
    return deps;
  }

  it("refuses a non-primary colleague's attempt to enable email visibility — nothing written", async () => {
    const deps = depsWithStored();
    const result = await updateDirectoryListing(
      { ...baseInput, fieldVisibility: { ...stored.fieldVisibility, contact_email: true } },
      colleague,
      ctx,
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('not_primary_contact');
    expect(deps.directoryRepo.upsertInTx).not.toHaveBeenCalled();
    expect(deps.audit.recordInTx).not.toHaveBeenCalled();
  });

  it("refuses a colleague turning the primary contact's name on when nothing is stored yet", async () => {
    const deps = stubDeps();
    vi.mocked(deps.directoryRepo.findByMemberIdInTx).mockResolvedValue(null);
    const result = await updateDirectoryListing(
      { ...baseInput, fieldVisibility: { name: true, contact_name: true } },
      colleague,
      ctx,
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('not_primary_contact');
    expect(deps.directoryRepo.upsertInTx).not.toHaveBeenCalled();
  });

  it('lets a colleague edit company fields when the contact toggles are resubmitted unchanged', async () => {
    const deps = depsWithStored();
    const result = await updateDirectoryListing(
      { ...baseInput, industry: 'Logistics', fieldVisibility: stored.fieldVisibility },
      colleague,
      ctx,
      deps,
    );
    expect(result.ok).toBe(true);
    expect(deps.directoryRepo.upsertInTx).toHaveBeenCalledWith(
      { fake: 'tx' },
      'm-1',
      expect.objectContaining({ industry: 'Logistics', recordContactChooser: false }),
    );
  });

  it('a save by the primary confirms toggles a predecessor chose, even when unchanged', async () => {
    const deps = depsWithStored();
    const result = await updateDirectoryListing(
      { ...baseInput, fieldVisibility: stored.fieldVisibility },
      memberMeta,
      ctx,
      deps,
    );
    expect(result.ok).toBe(true);
    expect(deps.directoryRepo.upsertInTx).toHaveBeenCalledWith(
      { fake: 'tx' },
      'm-1',
      expect.objectContaining({ recordContactChooser: true }),
    );
  });

  it('lets the primary contact publish their own email, recorded as a contact-visibility change', async () => {
    const deps = depsWithStored();
    const result = await updateDirectoryListing(
      { ...baseInput, fieldVisibility: { ...stored.fieldVisibility, contact_email: true } },
      memberMeta,
      ctx,
      deps,
    );
    expect(result.ok).toBe(true);
    expect(deps.directoryRepo.upsertInTx).toHaveBeenCalledWith(
      { fake: 'tx' },
      'm-1',
      expect.objectContaining({ recordContactChooser: true }),
    );
    expect(deps.audit.recordInTx).toHaveBeenCalledWith(
      { fake: 'tx' },
      expect.objectContaining({
        payload: expect.objectContaining({ contact_visibility_changed: true }),
      }),
    );
  });
});
