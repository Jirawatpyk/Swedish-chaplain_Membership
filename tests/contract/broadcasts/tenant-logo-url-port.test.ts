/**
 * F119 T027 — `getTenantLogoPublicUrl` (invoicing barrel, READ-only) behind
 * `TenantLogoUrlPort` (research R12, FR-041a/b).
 *
 * The chamber logo is the one already on file for invoices
 * (`tenant_invoice_settings.logo_blob_key`, super-admin only). Broadcasts
 * READS its public URL through the invoicing module's interface — one
 * artefact, set once, used in both places. Fail-soft: `null` ⇒ the email
 * header renders the chamber name exactly as today.
 *
 * Caches mirror `loadTenantLogo`: a positive FIFO cache keyed by blob key
 * (a re-upload mints a new UUID key, so stale entries are unreachable) and
 * a 60 s negative cache so a deleted blob does not cost a round-trip per
 * render.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetTenantLogoUrlCacheForTesting,
  makeGetTenantLogoPublicUrl,
} from '@/modules/invoicing/application/lib/tenant-logo-public-url';

function makeDeps(overrides?: {
  logoBlobKey?: string | null;
  settingsRow?: boolean;
  signThrows?: boolean;
}) {
  const getForIssue = vi.fn(async () =>
    overrides?.settingsRow === false
      ? null
      : ({ identity: { logo_blob_key: overrides && 'logoBlobKey' in overrides ? overrides.logoBlobKey : 'invoicing/t/logos/abc.png' } } as never),
  );
  const signDownloadUrl = vi.fn(async (key: string) => {
    if (overrides?.signThrows) throw new Error('blob 404');
    return `https://blob.example/${key}`;
  });
  return {
    deps: { settings: { getForIssue } as never, blob: { signDownloadUrl } as never },
    getForIssue,
    signDownloadUrl,
  };
}

describe('getTenantLogoPublicUrl — T027', () => {
  beforeEach(() => {
    _resetTenantLogoUrlCacheForTesting();
    vi.useRealTimers();
  });

  it('a logo on file → its public blob URL, resolved from the stored key', async () => {
    const { deps, signDownloadUrl } = makeDeps();
    const get = makeGetTenantLogoPublicUrl(deps);
    await expect(get('swecham')).resolves.toBe('https://blob.example/invoicing/t/logos/abc.png');
    expect(signDownloadUrl).toHaveBeenCalledWith('invoicing/t/logos/abc.png');
  });

  it('no logo on file → null, header falls back to the chamber name (no blob call)', async () => {
    const { deps, signDownloadUrl } = makeDeps({ logoBlobKey: null });
    const get = makeGetTenantLogoPublicUrl(deps);
    await expect(get('swecham')).resolves.toBeNull();
    expect(signDownloadUrl).not.toHaveBeenCalled();
  });

  it('no settings row at all → null (a tenant that never set up invoicing)', async () => {
    const { deps } = makeDeps({ settingsRow: false });
    await expect(makeGetTenantLogoPublicUrl(deps)('swecham')).resolves.toBeNull();
  });

  it('a blob resolution failure is fail-soft: null, and negatively cached for 60 s', async () => {
    vi.useFakeTimers();
    const { deps, signDownloadUrl } = makeDeps({ signThrows: true });
    const get = makeGetTenantLogoPublicUrl(deps);
    await expect(get('swecham')).resolves.toBeNull();
    await expect(get('swecham')).resolves.toBeNull();
    expect(signDownloadUrl).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(61_000);
    await expect(get('swecham')).resolves.toBeNull();
    expect(signDownloadUrl).toHaveBeenCalledTimes(2);
  });

  it('a resolved URL is positively cached by blob key — a second render costs no blob call', async () => {
    const { deps, signDownloadUrl } = makeDeps();
    const get = makeGetTenantLogoPublicUrl(deps);
    await get('swecham');
    await get('swecham');
    expect(signDownloadUrl).toHaveBeenCalledTimes(1);
  });

  it('is exported from the invoicing barrel as a bound, READ-only function', async () => {
    const barrel = await import('@/modules/invoicing');
    expect(typeof barrel.getTenantLogoPublicUrl).toBe('function');
    // No write surface travels with it: the barrel exposes no logo setter.
    expect((barrel as Record<string, unknown>)['setTenantLogo']).toBeUndefined();
    expect((barrel as Record<string, unknown>)['makeUploadTenantLogoDeps']).toBeUndefined();
  });
});
