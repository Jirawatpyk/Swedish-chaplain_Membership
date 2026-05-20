/**
 * T092 (F7.1a US7) — Contract test for template HTML escaping at
 * snapshot per critique E6/E9 + contracts § 5.1.
 *
 * Verifies XSS-prevention semantics:
 *   - {{chamber_name}} value is HTML-escaped before substitution (5
 *     OWASP metachars: < > & " ')
 *   - [bracketed text] is NOT escaped (literal plain text, not
 *     user-input — the brackets are visual placeholders for the
 *     member to overwrite at compose time)
 *
 * Pure Domain VO contract — uses STATIC import of T097 (which ships
 * in the same Phase 5A commit). RED-first per Constitution Principle II.
 */
import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  substituteChamberName,
} from '@/modules/broadcasts/domain/value-objects/template-snapshot';

describe('template HTML escape at snapshot — T092 (F7.1a US7)', () => {
  it('escapes < > in chamber_name', () => {
    expect(substituteChamberName('{{chamber_name}}', '<x>')).toBe(
      '&lt;x&gt;',
    );
  });

  it('escapes XSS payload as full string of HTML entities', () => {
    const payload = '"><script>alert(1)</script>';
    const result = substituteChamberName('{{chamber_name}}', payload);
    expect(result).toBe(
      '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;',
    );
    // Belt-and-braces — none of the raw metachars should survive
    expect(result).not.toMatch(/<|>|"/);
  });

  it('escapes & in chamber_name without double-escaping subsequent entities', () => {
    expect(substituteChamberName('{{chamber_name}}', 'A & B & C')).toBe(
      'A &amp; B &amp; C',
    );
    // Verify the order-of-replace invariant: & must escape FIRST so
    // that any subsequent metachar transformation doesn't recursively
    // re-escape the &amp; entity.
    expect(escapeHtml('<&>')).toBe('&lt;&amp;&gt;');
  });

  it('does NOT escape [bracketed text] (literal text, not user-input)', () => {
    const body =
      '<p>Hello [member name], welcome to {{chamber_name}}.</p>';
    const result = substituteChamberName(body, 'SweCham');
    expect(result).toBe(
      '<p>Hello [member name], welcome to SweCham.</p>',
    );
    // Brackets survive unescaped + un-substituted
    expect(result).toContain('[member name]');
    expect(result).not.toContain('&#91;'); // no [ entity
    expect(result).not.toContain('&#93;'); // no ] entity
  });

  it('preserves empty chamber_name value as empty (no entity injection)', () => {
    // Edge: tenants.display_name being empty string SHOULD substitute
    // to literally nothing — NOT to a placeholder entity.
    expect(substituteChamberName('Hello {{chamber_name}}!', '')).toBe(
      'Hello !',
    );
  });

  it('escapes apostrophe-style XSS payloads', () => {
    const result = substituteChamberName(
      '{{chamber_name}}',
      "' onload='alert(1)",
    );
    expect(result).toBe('&#39; onload=&#39;alert(1)');
    expect(result).not.toContain("'");
  });
});
