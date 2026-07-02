/**
 * 088 US8 UX-B1 (T061e-1) — unit test for the invoicing ClamAV adapter.
 *
 * Two concerns:
 *   1. `classifyError` maps fetch/transport failures onto the port verdict
 *      union (timeout / unreachable / unknown) — mirrors the broadcasts adapter
 *      test so a Node-fetch wording change fails loudly here.
 *   2. Empty `env.clamav.scanUrl` (the dev default) → `error/unconfigured`
 *      WITHOUT firing a network request (fail-closed). This is the branch the
 *      operator flips at go-live by setting CLAMAV_SCAN_URL/CLAMAV_SCAN_SECRET.
 *
 * NOTE (module boundary): this exercises invoicing's OWN adapter
 * (`@/modules/invoicing/infrastructure/adapters/clamav-virus-scanner`), NOT the
 * broadcasts one — Constitution Principle III forbids the cross-module import.
 */
import { describe, expect, it, vi } from 'vitest';

// Force the fail-closed unconfigured branch: the test env's `.env.local` sets a
// real CLAMAV_SCAN_URL, so override just `env.clamav.scanUrl` to empty here.
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      clamav: { ...actual.env.clamav, scanUrl: '', scanSecret: '' },
    },
  };
});

import {
  classifyError,
  makeClamavVirusScanner,
} from '@/modules/invoicing/infrastructure/adapters/clamav-virus-scanner';
import { env } from '@/lib/env';

describe('invoicing clamav classifyError', () => {
  it('classifies AbortError (fetch timeout) as verdict: timeout', () => {
    const abort = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });
    const r = classifyError(abort, 50_000);
    expect(r.verdict).toBe('timeout');
    expect(r.durationMs).toBe(50_000);
  });

  it('classifies ECONNREFUSED as verdict: error, reason: unreachable', () => {
    const r = classifyError(new Error('connect ECONNREFUSED 127.0.0.1:443'), 42);
    expect(r.verdict).toBe('error');
    if (r.verdict !== 'error') throw new Error('narrowing failed');
    expect(r.reason).toBe('unreachable');
  });

  it('classifies unrecognised errors as verdict: error, reason: unknown', () => {
    const r = classifyError(new Error('weird wrapper response'), 7);
    expect(r.verdict).toBe('error');
    if (r.verdict !== 'error') throw new Error('narrowing failed');
    expect(r.reason).toBe('unknown');
    expect(r.detail).toBe('weird wrapper response');
  });
});

describe('makeClamavVirusScanner — unconfigured (empty scanUrl)', () => {
  it('returns error/unconfigured WITHOUT firing a network request', async () => {
    // The dev default is empty scanUrl. Guard the assumption so an env leak
    // (CLAMAV_SCAN_URL set in the test env) surfaces instead of a false pass.
    expect(env.clamav.scanUrl).toBe('');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const scanner = makeClamavVirusScanner();
      const r = await scanner.scan(Buffer.from('bytes'));
      expect(r.verdict).toBe('error');
      if (r.verdict !== 'error') throw new Error('narrowing failed');
      expect(r.reason).toBe('unconfigured');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
