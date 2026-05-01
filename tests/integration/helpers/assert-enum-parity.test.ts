/**
 * Unit-level tests for the pure logic inside `assert-enum-parity.ts`.
 *
 * Co-located in `tests/integration/helpers/` (alongside the helper)
 * even though these cases don't touch the DB — keeps the helper +
 * its lock-in tests within one directory. The DB-touching parity tests
 * (F4/F5/F7×2) live in their respective feature dirs and exercise
 * `getEnumParity` end-to-end on live Neon; THIS file locks the
 * `resolveScopeFilter` precedence + declarative→predicate translation
 * rules so a contributor cannot accidentally flip them.
 *
 * Review PR #20 round-2 #2 — adds the unit lock-in.
 */
import { describe, expect, it, vi } from 'vitest';

import { resolveScopeFilter } from './assert-enum-parity';

describe('resolveScopeFilter', () => {
  it('no options at all → returns undefined (entire enum in-scope)', () => {
    const fn = resolveScopeFilter({
      typeName: 'audit_event_type',
      tsValues: [],
    });
    expect(fn).toBeUndefined();
  });

  it('prefixes only → matches labels by startsWith', () => {
    const fn = resolveScopeFilter({
      typeName: 'audit_event_type',
      tsValues: [],
      prefixes: ['invoice_', 'credit_note_'],
    });
    expect(fn).toBeDefined();
    if (fn === undefined) throw new Error('unreachable');

    expect(fn('invoice_issued')).toBe(true);
    expect(fn('credit_note_issued')).toBe(true);
    expect(fn('payment_initiated')).toBe(false);
    expect(fn('broadcast_drafted')).toBe(false);
  });

  it('extraInclude only → matches explicit labels (no prefix needed)', () => {
    const fn = resolveScopeFilter({
      typeName: 'audit_event_type',
      tsValues: [],
      extraInclude: ['auto_email_delivery_failed'],
    });
    expect(fn).toBeDefined();
    if (fn === undefined) throw new Error('unreachable');

    expect(fn('auto_email_delivery_failed')).toBe(true);
    expect(fn('invoice_issued')).toBe(false);
  });

  it('prefixes + extraInclude composes (OR) — F4-shaped scope', () => {
    const fn = resolveScopeFilter({
      typeName: 'audit_event_type',
      tsValues: [],
      prefixes: ['invoice_', 'credit_note_', 'receipt_'],
      extraInclude: ['auto_email_delivery_failed'],
    });
    expect(fn).toBeDefined();
    if (fn === undefined) throw new Error('unreachable');

    // Prefix match
    expect(fn('invoice_issued')).toBe(true);
    expect(fn('receipt_pdf_resent')).toBe(true);
    // Extra-include match
    expect(fn('auto_email_delivery_failed')).toBe(true);
    // Out of scope
    expect(fn('payment_initiated')).toBe(false);
  });

  it('extraExclude carves out exceptions AFTER prefixes/extraInclude', () => {
    const fn = resolveScopeFilter({
      typeName: 'audit_event_type',
      tsValues: [],
      prefixes: ['payment_'],
      extraExclude: ['payment_dispute_evidence_uploaded'],
    });
    expect(fn).toBeDefined();
    if (fn === undefined) throw new Error('unreachable');

    expect(fn('payment_initiated')).toBe(true);
    // Excluded — would match prefix but is carved out
    expect(fn('payment_dispute_evidence_uploaded')).toBe(false);
  });

  it('extraExclude wins over extraInclude when the same label is in both', () => {
    const fn = resolveScopeFilter({
      typeName: 'audit_event_type',
      tsValues: [],
      extraInclude: ['shared_label'],
      extraExclude: ['shared_label'],
    });
    expect(fn).toBeDefined();
    if (fn === undefined) throw new Error('unreachable');

    // Exclude is checked first in the closure, so it wins.
    expect(fn('shared_label')).toBe(false);
  });

  it('predicate wins when BOTH sqlScopeFilter AND declarative options are supplied + warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const declarativePredicate = (label: string): boolean =>
      label.startsWith('declarative_');
    const explicitPredicate = (label: string): boolean =>
      label.startsWith('predicate_');

    const fn = resolveScopeFilter({
      typeName: 'audit_event_type',
      tsValues: [],
      sqlScopeFilter: explicitPredicate,
      prefixes: ['declarative_'],
    });
    expect(fn).toBeDefined();
    if (fn === undefined) throw new Error('unreachable');

    // Predicate wins — declarative `prefixes` is ignored.
    expect(fn('predicate_value')).toBe(true);
    expect(fn('declarative_value')).toBe(false);
    // Sanity: the unused declarative predicate matches what we expected
    // it to match.
    expect(declarativePredicate('declarative_value')).toBe(true);

    // Warn fires exactly once with the expected guidance.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('audit_event_type');
    expect(warnSpy.mock.calls[0]?.[0]).toContain('predicate wins');

    warnSpy.mockRestore();
  });

  it('sqlScopeFilter only (no declarative) does NOT warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const fn = resolveScopeFilter({
      typeName: 'audit_event_type',
      tsValues: [],
      sqlScopeFilter: (label) => label.startsWith('broadcast_'),
    });
    expect(fn).toBeDefined();
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
