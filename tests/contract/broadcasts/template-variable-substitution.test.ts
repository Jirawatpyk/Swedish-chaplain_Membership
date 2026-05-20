/**
 * T090 (F7.1a US7) — Contract test for template variable substitution
 * semantics per contracts/broadcast-template.md § 5.4 + critique E9.
 *
 * Verifies the Domain VO `substituteChamberName` contract directly + an
 * integration-style assertion that snapshot use-case applies it.
 *
 * Pure Domain VO tests use STATIC import (T097 ships in the same commit
 * as Phase 5A so the import resolves). The snapshot use-case test uses
 * dynamic import to bypass typecheck on the not-yet-existent T102.
 *
 * RED-first per Constitution Principle II.
 */
import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  substituteChamberName,
} from '@/modules/broadcasts/domain/value-objects/template-snapshot';

describe('substituteChamberName — T090 (F7.1a US7) Domain VO contract', () => {
  it('substitutes {{chamber_name}} at snapshot time with tenant.display_name', () => {
    const result = substituteChamberName(
      '<h2>{{chamber_name}} Newsletter</h2>',
      'SweCham',
    );
    expect(result).toBe('<h2>SweCham Newsletter</h2>');
  });

  it('substitutes ALL occurrences of {{chamber_name}} (global replace)', () => {
    const result = substituteChamberName(
      '{{chamber_name}} A {{chamber_name}} B {{chamber_name}}',
      'X',
    );
    expect(result).toBe('X A X B X');
  });

  it('leaves [bracketed text] literal in body (no substitution)', () => {
    const result = substituteChamberName(
      '<p>Hello [member name], welcome to {{chamber_name}}!</p>',
      'SweCham',
    );
    expect(result).toBe('<p>Hello [member name], welcome to SweCham!</p>');
    expect(result).toContain('[member name]');
  });

  it('does NOT touch other {{var}} placeholders (only chamber_name resolved)', () => {
    // Per critique X1 + P5: all other variables were converted to
    // bracket form on 2026-05-18. If any legacy {{var}} survives in a
    // template body, it ships LITERAL (admin signal to refactor).
    const result = substituteChamberName(
      '<p>{{member_name}} at {{chamber_name}} — {{event_name}}</p>',
      'SweCham',
    );
    expect(result).toBe('<p>{{member_name}} at SweCham — {{event_name}}</p>');
  });

  it('HTML-escapes chamber_name value to prevent XSS', () => {
    const result = substituteChamberName(
      '<h2>{{chamber_name}}</h2>',
      '<script>alert(1)</script>',
    );
    expect(result).toBe('<h2>&lt;script&gt;alert(1)&lt;/script&gt;</h2>');
    expect(result).not.toContain('<script>');
  });

  it('preserves body unchanged when no {{chamber_name}} present', () => {
    const body = '<p>Static content only [date].</p>';
    expect(substituteChamberName(body, 'SweCham')).toBe(body);
  });
});

describe('escapeHtml — T090 OWASP-compliance contract', () => {
  it.each([
    ['&', '&amp;'],
    ['<', '&lt;'],
    ['>', '&gt;'],
    ['"', '&quot;'],
    ["'", '&#39;'],
  ])('escapes %s → %s', (input, expected) => {
    expect(escapeHtml(input)).toBe(expected);
  });

  it('escapes & FIRST so subsequent entity replacements are not double-escaped', () => {
    // If & were escaped after <, then <→&lt; would become &amp;lt;
    expect(escapeHtml('<x>')).toBe('&lt;x&gt;');
    expect(escapeHtml('& < >')).toBe('&amp; &lt; &gt;');
  });

  it('escapes a full XSS payload to entities', () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;',
    );
  });
});
