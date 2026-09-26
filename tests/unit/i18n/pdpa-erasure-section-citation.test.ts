/**
 * Erasure copy must cite PDPA section 33 (right to erasure), not section 30
 * (right of access). The events erasure page hint and both erasure reason
 * placeholders cited "Section 30" / "มาตรา 30" / "paragraf 30" in every
 * locale; this pins the correction on EN/TH/SV.
 */
import { describe, expect, it } from 'vitest';
import en from '@/i18n/messages/en.json';
import th from '@/i18n/messages/th.json';
import sv from '@/i18n/messages/sv.json';

type Tree = Record<string, unknown>;

function get(tree: Tree, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (node, key) => (node && typeof node === 'object' ? (node as Tree)[key] : undefined),
    tree,
  );
}

const ERASURE_KEYS = [
  'admin.events.erasure.pageHint',
  'admin.events.erasure.reasonPlaceholder',
  'admin.events.detail.erase.reasonPlaceholder',
] as const;

const LOCALES = [
  ['en', en, /PDPA Section 33\b/],
  ['th', th, /มาตรา 33\b/],
  ['sv', sv, /(?:§ ?|paragraf )33\b/],
] as const;

const SECTION_30 = /Section 30\b|§ ?30\b|มาตรา 30\b|paragraf 30\b/;

describe('PDPA erasure copy cites section 33, not section 30', () => {
  // PDPA has no identity-verification section; the member erase attestation
  // cites GDPR Art. 12(6) for the check and PDPA §33 for the request.
  it('admin.members.erase.attestationLabel', () => {
    for (const [locale, tree] of LOCALES) {
      const value = get(tree as Tree, 'admin.members.erase.attestationLabel');
      expect(typeof value, locale).toBe('string');
      expect(value as string, locale).not.toMatch(SECTION_30);
      expect(value as string, locale).toMatch(/PDPA (?:§ ?|มาตรา )33\b/);
      expect(value as string, locale).toMatch(/12(?:\(6\)|\.6)/);
    }
  });

  for (const path of ERASURE_KEYS) {
    it(path, () => {
      for (const [locale, tree, section33] of LOCALES) {
        const value = get(tree as Tree, path);
        expect(typeof value, `${locale}: ${path}`).toBe('string');
        expect(value as string, `${locale}: ${path}`).not.toMatch(SECTION_30);
        expect(value as string, `${locale}: ${path}`).toMatch(section33);
      }
    });
  }
});
