/**
 * F9 US5 (T079) — `setDirectoryLogo` guard-branch unit tests.
 *
 * Covers branches that short-circuit BEFORE re-encode/upload/runInTenant:
 * manager forbidden, member editing another member forbidden, oversize, and
 * declared-MIME allow-list. The re-encode + upload + audit write path is the
 * live-Neon integration test.
 */
import { describe, expect, it, vi } from 'vitest';
import { asTenantContext } from '@/modules/tenants';
import {
  setDirectoryLogo,
  MAX_LOGO_UPLOAD_BYTES,
  type DirectoryLogoMeta,
  type SetDirectoryLogoDeps,
} from '@/modules/insights/application/use-cases/set-directory-logo';

const ctx = asTenantContext('test-tenant');

function stubDeps(): SetDirectoryLogoDeps {
  return {
    directoryRepo: {
      findByMemberIdInTx: vi.fn(),
      findByMemberId: vi.fn(),
      upsertInTx: vi.fn(),
      setLogoInTx: vi.fn(),
      search: vi.fn(),
      listPublishedInTx: vi.fn(),
    },
    image: { reencode: vi.fn() },
    logoStore: { putPublicLogo: vi.fn(), deleteLogo: vi.fn() },
    audit: { recordInTx: vi.fn(), record: vi.fn() },
  };
}

const memberMeta: DirectoryLogoMeta = {
  actorUserId: 'u-1',
  actorRole: 'member',
  actorMemberId: 'm-1',
  requestId: 'req-1',
};

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

describe('setDirectoryLogo — guard branches', () => {
  it('manager is forbidden (read-only)', async () => {
    const deps = stubDeps();
    const r = await setDirectoryLogo(
      { memberId: 'm-1', bytes: png, declaredMime: 'image/png' },
      { ...memberMeta, actorRole: 'manager', actorMemberId: null },
      ctx,
      deps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('forbidden');
    expect(deps.image.reencode).not.toHaveBeenCalled();
  });

  it("member editing another member's logo is forbidden", async () => {
    const deps = stubDeps();
    const r = await setDirectoryLogo(
      { memberId: 'm-2', bytes: png, declaredMime: 'image/png' },
      memberMeta,
      ctx,
      deps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('forbidden');
  });

  it('rejects an oversize upload before re-encode', async () => {
    const deps = stubDeps();
    const big = new Uint8Array(MAX_LOGO_UPLOAD_BYTES + 1);
    const r = await setDirectoryLogo(
      { memberId: 'm-1', bytes: big, declaredMime: 'image/png' },
      memberMeta,
      ctx,
      deps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('too_large');
    expect(deps.image.reencode).not.toHaveBeenCalled();
  });

  it('rejects a non-allow-listed declared MIME', async () => {
    const deps = stubDeps();
    const r = await setDirectoryLogo(
      { memberId: 'm-1', bytes: png, declaredMime: 'image/gif' },
      memberMeta,
      ctx,
      deps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('unsupported_format');
    expect(deps.image.reencode).not.toHaveBeenCalled();
  });
});
