/**
 * T067 (F7.1a US2) — Unit tests for `image-source-allowlist` Domain VO.
 *
 * Pure functions; no infrastructure. Phase 4 RED-first per Constitution
 * Principle II NON-NEGOTIABLE.
 */
import { describe, expect, it } from 'vitest';
import {
  asHostname,
  validateHostname,
  extractImgSources,
} from '@/modules/broadcasts/domain/value-objects/image-source-allowlist';
import type { Hostname } from '@/modules/broadcasts/application/ports/image-allowlist-port';

describe('image-source-allowlist (Domain VO) — T067 (F7.1a US2)', () => {
  describe('asHostname', () => {
    it('accepts RFC-1035 lowercase ASCII hostname with ≥1 dot', () => {
      const result = asHostname('example.com');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe('example.com');
    });

    it('accepts subdomain', () => {
      expect(asHostname('cdn.example.com').ok).toBe(true);
    });

    it('rejects uppercase characters', () => {
      const result = asHostname('Example.com');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('invalid_hostname');
    });

    it('rejects wildcards', () => {
      expect(asHostname('*.example.com').ok).toBe(false);
    });

    it('rejects bare TLD (no dot)', () => {
      expect(asHostname('localhost').ok).toBe(false);
    });

    it('rejects empty string', () => {
      expect(asHostname('').ok).toBe(false);
    });

    it('rejects scheme prefix', () => {
      expect(asHostname('https://example.com').ok).toBe(false);
    });

    it('rejects hostname longer than 253 chars', () => {
      const long = 'a.' + 'a'.repeat(255);
      expect(asHostname(long).ok).toBe(false);
    });
  });

  describe('validateHostname', () => {
    const allowlist = [
      { hostname: 'cdn.example.com' as Hostname, isDefault: true },
      { hostname: 'assets.swecham.zyncdata.app' as Hostname, isDefault: true },
    ] as const;

    it('returns ok when hostname exact-matches an allowlist entry', () => {
      const result = validateHostname(
        'cdn.example.com' as Hostname,
        allowlist,
      );
      expect(result.ok).toBe(true);
    });

    it('returns err when hostname NOT in allowlist', () => {
      const result = validateHostname('attacker.com' as Hostname, allowlist);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('not_allowlisted');
    });

    it('does NOT match subdomains transitively', () => {
      // cdn.example.com is allowlisted; sub.cdn.example.com is NOT.
      expect(
        validateHostname('sub.cdn.example.com' as Hostname, allowlist).ok,
      ).toBe(false);
    });
  });

  describe('extractImgSources', () => {
    it('returns empty array when body has no <img>', () => {
      expect(extractImgSources('<p>hello</p>')).toEqual([]);
    });

    it('extracts single img src + alt', () => {
      const out = extractImgSources(
        '<p>x<img src="https://cdn.example.com/a.png" alt="logo"></p>',
      );
      expect(out).toEqual([
        { src: 'https://cdn.example.com/a.png', alt: 'logo' },
      ]);
    });

    it('extracts multiple imgs in document order', () => {
      const out = extractImgSources(
        '<img src="https://a.example.com/1.png"><img src="https://b.example.com/2.png">',
      );
      expect(out).toHaveLength(2);
      expect(out[0]?.src).toBe('https://a.example.com/1.png');
      expect(out[1]?.src).toBe('https://b.example.com/2.png');
    });

    it('handles missing alt (returns undefined)', () => {
      const out = extractImgSources(
        '<img src="https://x.example.com/y.png">',
      );
      expect(out[0]?.alt).toBeUndefined();
    });

    it('does NOT extract from script content (parser-safety)', () => {
      const out = extractImgSources(
        '<script>var x = "<img src=evil>";</script><img src="https://ok.example.com/y.png">',
      );
      expect(out).toEqual([{ src: 'https://ok.example.com/y.png' }]);
    });

    it('does NOT extract from style content', () => {
      const out = extractImgSources(
        '<style>div { background: url("<img src=evil>"); }</style><img src="https://ok.example.com/y.png">',
      );
      expect(out).toEqual([{ src: 'https://ok.example.com/y.png' }]);
    });

    // Bug #2 regression: a literal '>' inside a quoted attribute value that
    // PRECEDES src must not truncate the tag before the extractor reaches
    // src. DOMPurify serialisation does NOT escape '>' inside attribute
    // values, so an author-controlled alt="a>b" previously made the allowlist
    // validator see zero image sources and pass a non-allowlisted src.
    it("extracts src when a preceding attr value contains '>' (allowlist-bypass regression)", () => {
      const out = extractImgSources(
        '<img alt="a>b" src="http://tracker.evil/pixel.png">',
      );
      expect(out).toEqual([
        { src: 'http://tracker.evil/pixel.png', alt: 'a>b' },
      ]);
    });

    it("extracts src when a single-quoted preceding attr value contains '>'", () => {
      const out = extractImgSources(
        "<img alt='x>y' src='http://tracker.evil/p.png'>",
      );
      expect(out[0]?.src).toBe('http://tracker.evil/p.png');
    });

    it("extracts src when a following attr value contains '>'", () => {
      const out = extractImgSources(
        '<img src="http://tracker.evil/q.png" title="1 > 0">',
      );
      expect(out[0]?.src).toBe('http://tracker.evil/q.png');
    });

    it("extracts every img even when the first carries a '>'-bearing attr", () => {
      const out = extractImgSources(
        '<img alt="a>b" src="http://one.evil/1.png"><img src="https://two.example.com/2.png">',
      );
      expect(out).toHaveLength(2);
      expect(out[0]?.src).toBe('http://one.evil/1.png');
      expect(out[1]?.src).toBe('https://two.example.com/2.png');
    });
  });
});
