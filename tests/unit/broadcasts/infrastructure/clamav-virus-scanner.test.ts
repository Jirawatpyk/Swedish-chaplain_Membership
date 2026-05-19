/**
 * Unit test — `classifyError` heuristic in `clamav-virus-scanner.ts`.
 *
 * F7.1a Phase 2 / /speckit.superb.critique Imp-3 closure (2026-05-19).
 *
 * `classifyError` maps thrown clamscan / NodeClam errors to one of
 * three `VirusScanVerdict` shapes — `timeout`, `error: unreachable`,
 * `error: unknown`. The mapping is a brittle string-match against
 * `error.message.toLowerCase()`; this test exercises every branch so
 * a future clamscan upgrade that changes error wording fails loudly
 * here instead of silently misclassifying production scans (which
 * would surface as a wrong OTel-metric verdict label in Phase 6
 * T122 — `broadcasts.image_scan_duration_ms{tenant,verdict}`).
 *
 * NOT marked as security-critical at 100% branch coverage — that
 * label belongs to `validateImageSourceAllowlist` (Phase 4 T070)
 * and `enforceCrossTenantIsolation` (Phase 2 RLS) per plan.md
 * Constitution Check II. `classifyError` covers an
 * infrastructure-layer routing decision, not a security boundary.
 */
import { describe, expect, it } from 'vitest';

import { classifyError } from '@/modules/broadcasts/infrastructure/clamav-virus-scanner';

describe('classifyError', () => {
  it('classifies "timeout" messages as verdict: timeout', () => {
    const r = classifyError(new Error('Scan timeout reached'), 5_000);
    expect(r.verdict).toBe('timeout');
    expect(r.durationMs).toBe(5_000);
  });

  it('classifies "ETIMEDOUT" Node socket errors as verdict: timeout (case-insensitive)', () => {
    const r = classifyError(new Error('ETIMEDOUT: connection timed out'), 7_500);
    expect(r.verdict).toBe('timeout');
    expect(r.durationMs).toBe(7_500);
  });

  it('classifies ECONNREFUSED as verdict: error, reason: unreachable', () => {
    const r = classifyError(new Error('connect ECONNREFUSED 127.0.0.1:3310'), 42);
    expect(r.verdict).toBe('error');
    if (r.verdict !== 'error') throw new Error('narrowing failed');
    expect(r.reason).toBe('unreachable');
    expect(r.detail).toContain('econnrefused');
    expect(r.durationMs).toBe(42);
  });

  it('classifies ENOTFOUND DNS failures as verdict: error, reason: unreachable', () => {
    const r = classifyError(new Error('getaddrinfo ENOTFOUND clamav-swecham.internal'), 100);
    expect(r.verdict).toBe('error');
    if (r.verdict !== 'error') throw new Error('narrowing failed');
    expect(r.reason).toBe('unreachable');
  });

  it('classifies EHOSTUNREACH as verdict: error, reason: unreachable', () => {
    const r = classifyError(new Error('EHOSTUNREACH 10.0.0.1:3310'), 200);
    expect(r.verdict).toBe('error');
    if (r.verdict !== 'error') throw new Error('narrowing failed');
    expect(r.reason).toBe('unreachable');
  });

  it('classifies unrecognised Error messages as verdict: error, reason: unknown', () => {
    const r = classifyError(new Error('Invalid response from clamd'), 1_234);
    expect(r.verdict).toBe('error');
    if (r.verdict !== 'error') throw new Error('narrowing failed');
    expect(r.reason).toBe('unknown');
    expect(r.detail).toBe('Invalid response from clamd');
    expect(r.durationMs).toBe(1_234);
  });

  it('classifies non-Error thrown values as verdict: error, reason: unknown with String() detail', () => {
    const r = classifyError('not an Error instance', 0);
    expect(r.verdict).toBe('error');
    if (r.verdict !== 'error') throw new Error('narrowing failed');
    expect(r.reason).toBe('unknown');
    expect(r.detail).toBe('not an Error instance');
  });

  it('classifies undefined as verdict: error, reason: unknown', () => {
    const r = classifyError(undefined, 0);
    expect(r.verdict).toBe('error');
    if (r.verdict !== 'error') throw new Error('narrowing failed');
    expect(r.reason).toBe('unknown');
    expect(r.detail).toBe('undefined');
  });

  it('preserves durationMs literally (no normalisation)', () => {
    expect(classifyError(new Error('x'), 0).durationMs).toBe(0);
    expect(classifyError(new Error('x'), 12_345.678).durationMs).toBe(12_345.678);
  });

  it('timeout match takes precedence over unreachable match', () => {
    // Hypothetical NodeClam error that combines both vocabularies — by
    // design the timeout branch fires first.
    const r = classifyError(new Error('timeout while waiting on ECONNREFUSED'), 0);
    expect(r.verdict).toBe('timeout');
  });
});
