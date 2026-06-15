/**
 * F9 #2 + #5 — per-actor rate limits on the directory logo upload + directory
 * artefact enqueue routes. Both run an expensive pipeline (sharp re-encode /
 * full-directory react-pdf render) that was previously uncapped. These pin the
 * 429 path (before the expensive work) + that an under-limit request proceeds.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { ok } from '@/lib/result';

const TENANT_SLUG = 'tenanta';

vi.mock('@/lib/env', () => ({
  env: { features: { f9Dashboard: true }, tenant: { slug: TENANT_SLUG } },
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: TENANT_SLUG }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('@/lib/log-id', () => ({ errKind: () => 'Error', rootCause: (e: unknown) => e }));
vi.mock('@/lib/rate-limit-helpers', () => ({ retryAfterSecondsFromRl: () => 60 }));

const sessionMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth-session', () => ({ getCurrentSession: sessionMock }));

const rlCheckMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth-deps', () => ({ rateLimiter: { check: rlCheckMock } }));

const findByLinkedUserIdMock = vi.hoisted(() => vi.fn());
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({ memberRepo: { findByLinkedUserId: findByLinkedUserIdMock } }),
}));

const setLogoMock = vi.hoisted(() => vi.fn());
const ebookMock = vi.hoisted(() => vi.fn());
const jsonExportMock = vi.hoisted(() => vi.fn());
vi.mock('@/modules/insights', () => ({
  setDirectoryLogo: setLogoMock,
  removeDirectoryLogo: vi.fn(),
  MAX_LOGO_UPLOAD_BYTES: 2 * 1024 * 1024,
  exportDirectoryJson: jsonExportMock,
  generateDirectoryEbook: ebookMock,
  makeGenerateDirectoryExportDeps: () => ({}),
}));
vi.mock('@/modules/insights/infrastructure/set-directory-logo-deps', () => ({
  makeSetDirectoryLogoDeps: () => ({}),
  makeRemoveDirectoryLogoDeps: () => ({}),
}));

const { POST: logoPost } = await import('@/app/api/portal/directory/logo/route');
const { POST: exportsPost } = await import('@/app/api/admin/directory/exports/route');

function req(body?: unknown): NextRequest {
  return {
    headers: { get: () => null },
    json: async () => body ?? {},
    formData: async () => {
      throw new Error('formData must not be reached when rate-limited');
    },
  } as unknown as NextRequest;
}

beforeEach(() => {
  sessionMock.mockReset();
  rlCheckMock.mockReset();
  findByLinkedUserIdMock.mockReset();
  setLogoMock.mockReset();
  ebookMock.mockReset();
  jsonExportMock.mockReset();
});

describe('portal/directory/logo POST — per-member rate limit (F9 #2)', () => {
  it('429 + Retry-After when the limiter trips, before the sharp pipeline', async () => {
    sessionMock.mockResolvedValue({ user: { id: 'u-mem', role: 'member' } });
    findByLinkedUserIdMock.mockResolvedValue(ok({ memberId: 'm-1' }));
    rlCheckMock.mockResolvedValue({ success: false, reset: 1_000 });

    const res = await logoPost(req());
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(setLogoMock).not.toHaveBeenCalled();
    expect(rlCheckMock).toHaveBeenCalledWith(`directory-logo:${TENANT_SLUG}:m-1`, 15, 60);
  });
});

describe('admin/directory/exports POST — per-actor rate limit (F9 #5)', () => {
  it('429 + Retry-After when the limiter trips, before enqueue', async () => {
    sessionMock.mockResolvedValue({ user: { id: 'u-adm', role: 'admin' } });
    rlCheckMock.mockResolvedValue({ success: false, reset: 1_000 });

    const res = await exportsPost(req({ kind: 'directory_ebook' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(ebookMock).not.toHaveBeenCalled();
    expect(rlCheckMock).toHaveBeenCalledWith(`directory-export:${TENANT_SLUG}:u-adm`, 10, 3600);
  });

  it('429 also gates the directory_json arm (same per-actor limiter)', async () => {
    sessionMock.mockResolvedValue({ user: { id: 'u-adm', role: 'admin' } });
    rlCheckMock.mockResolvedValue({ success: false, reset: 1_000 });

    const res = await exportsPost(req({ kind: 'directory_json' }));
    expect(res.status).toBe(429);
    expect(jsonExportMock).not.toHaveBeenCalled();
  });

  it('proceeds to enqueue when under the limit', async () => {
    sessionMock.mockResolvedValue({ user: { id: 'u-adm', role: 'admin' } });
    rlCheckMock.mockResolvedValue({ success: true, reset: 0 });
    ebookMock.mockResolvedValue(ok({ jobId: 'job-1' }));

    const res = await exportsPost(req({ kind: 'directory_ebook' }));
    expect(res.status).toBe(200);
    expect(ebookMock).toHaveBeenCalledOnce();
  });
});
