/**
 * Unit test — pure helpers in `clamav-endpoint-resolver.ts`.
 *
 * F7.1a Phase 2 / /speckit.superb.critique Imp-3 closure (2026-05-19).
 *
 * Covers `classifyClamavMode` (host → mode mapping) and
 * `isValidClamavHost` (sanity validation). Both are exported
 * separately from `resolveClamavEndpoint` precisely so this test
 * can exercise every branch without `vi.mock('@/lib/env')` ceremony.
 *
 * The env-aware `resolveClamavEndpoint` itself is covered implicitly
 * by `scripts/verify-clamav-connectivity.ts` (Phase 1) which reads
 * the real env at runtime.
 */
import { describe, expect, it } from 'vitest';

import {
  classifyClamavMode,
  isValidClamavHost,
} from '@/modules/broadcasts/infrastructure/clamav-endpoint-resolver';

describe('classifyClamavMode', () => {
  it('classifies *.internal as production (Fly.io 6PN convention)', () => {
    expect(classifyClamavMode('clamav-swecham.internal')).toBe('production');
    expect(classifyClamavMode('app.internal')).toBe('production');
    expect(classifyClamavMode('clamav-staging.internal')).toBe('production');
  });

  it('classifies localhost as development', () => {
    expect(classifyClamavMode('localhost')).toBe('development');
  });

  it('classifies 127.0.0.1 as development', () => {
    expect(classifyClamavMode('127.0.0.1')).toBe('development');
  });

  it('classifies bare DNS / custom IP as staging', () => {
    expect(classifyClamavMode('clamav-staging.example.com')).toBe('staging');
    expect(classifyClamavMode('10.0.0.42')).toBe('staging');
    expect(classifyClamavMode('clamav.internal.example.com')).toBe('staging'); // not ending in .internal
  });

  it('is case-sensitive for the .internal suffix (Fly DNS is lowercase)', () => {
    expect(classifyClamavMode('CLAMAV.INTERNAL')).toBe('staging');
    expect(classifyClamavMode('Clamav-Swecham.Internal')).toBe('staging');
  });

  it('does not match partial substring (.internal must be at suffix)', () => {
    expect(classifyClamavMode('internal-host.example.com')).toBe('staging');
    expect(classifyClamavMode('internal')).toBe('staging');
  });
});

describe('isValidClamavHost', () => {
  it('accepts bare hostnames', () => {
    expect(isValidClamavHost('localhost')).toBe(true);
    expect(isValidClamavHost('127.0.0.1')).toBe(true);
    expect(isValidClamavHost('clamav-swecham.internal')).toBe(true);
    expect(isValidClamavHost('clamav-staging.example.com')).toBe(true);
  });

  it('rejects hosts with URL scheme', () => {
    expect(isValidClamavHost('tcp://clamav-swecham.internal')).toBe(false);
    expect(isValidClamavHost('http://localhost')).toBe(false);
  });

  it('rejects hosts with path component', () => {
    expect(isValidClamavHost('localhost/api')).toBe(false);
    expect(isValidClamavHost('clamav.internal/v1/scan')).toBe(false);
  });

  it('rejects hosts with whitespace', () => {
    expect(isValidClamavHost('local host')).toBe(false);
    expect(isValidClamavHost(' localhost')).toBe(false);
    expect(isValidClamavHost('localhost ')).toBe(false);
  });

  it('accepts empty string (caller checks empty separately as "unconfigured")', () => {
    // The resolver's `if (!host)` branch fires before this validator
    // is consulted; isValidClamavHost('') intentionally returns true
    // so caller doesn't double-report empty as "invalid_host".
    expect(isValidClamavHost('')).toBe(true);
  });
});
