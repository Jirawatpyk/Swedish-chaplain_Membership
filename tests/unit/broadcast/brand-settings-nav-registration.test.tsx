/**
 * F119 T029 — the Brand page is registered in THREE places, and all three
 * agree (contracts/admin-eblast-formatting-api.md § "the Brand page").
 *
 * `src/config/nav.ts` and `src/app/(staff)/admin/settings/page.tsx` both carry
 * docblocks recording a past incident of a surface being registered in one and
 * forgotten in the other: the sidebar and the Settings-index hub each claim to
 * mirror the other, and each has been wrong. The nav guard key must equal the
 * page's `requirePagePermission` key, or a holder is either shown a dead link
 * (looser nav) or hidden from a page they may open (stricter nav).
 *
 * Read from the REAL artefacts — the nav config object, the settings index
 * source, and the page source — never from a fixture that would keep passing
 * after either side changed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { flattenNavItems, staffNavConfig, type NavItem } from '@/config/nav';
import enMessages from '@/i18n/messages/en.json';
import thMessages from '@/i18n/messages/th.json';
import svMessages from '@/i18n/messages/sv.json';

const ROOT = process.cwd();
const HREF = '/admin/settings/broadcasts/brand';
const KEY = 'settings.broadcasts';
const INDEX_FILE = join(ROOT, 'src/app/(staff)/admin/settings/page.tsx');
const PAGE_FILE = join(ROOT, 'src/app/(staff)/admin/settings/broadcasts/brand/page.tsx');

function navItem(): NavItem | undefined {
  return flattenNavItems(staffNavConfig).find((i) => i.href === HREF);
}

/** The `CATEGORIES` entry as DECLARED in the settings-index source. */
function categoryBlock(): string {
  const src = readFileSync(INDEX_FILE, 'utf8');
  const start = src.indexOf('const CATEGORIES = [');
  expect(start, 'CATEGORIES not found in the settings index').toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf('] as const;', start));
  const block = (body.match(/\{[^{}]*\}/g) ?? []).find((b) => b.includes(`href: '${HREF}'`));
  expect(block, `no CATEGORIES entry for ${HREF}`).toBeDefined();
  return block!;
}

describe('F119 T029 — the nav entry, the settings card and the page name the same permission key', () => {
  it('the sidebar carries the entry, guarded on settings.broadcasts', () => {
    const item = navItem();
    expect(item, `no staffNavConfig entry for ${HREF}`).toBeDefined();
    expect(item!.guard?.key).toBe(KEY);
    // Same F7 dimension as its sibling: a switched-off feature must not leave
    // a dead link, and the page `notFound()`s on the same flag.
    expect(item!.visibilityFlag).toBe('broadcastsEnabled');
  });

  it('the Settings-index card carries the entry with the same key', () => {
    expect(categoryBlock()).toContain(`permission: '${KEY}'`);
    expect(categoryBlock()).toContain("visibilityFlag: 'broadcastsEnabled'");
  });

  it('the page guards on the same key — all three literals agree', () => {
    const pageSrc = readFileSync(PAGE_FILE, 'utf8');
    expect(pageSrc).toContain(`requirePagePermission('${KEY}')`);
    expect(navItem()!.guard?.key).toBe(KEY);
    expect(categoryBlock()).toContain(`permission: '${KEY}'`);
  });

  it('the sidebar entry and the card point at the SAME href', () => {
    expect(navItem()!.href).toBe(HREF);
    expect(categoryBlock()).toContain(`href: '${HREF}'`);
  });

  it('the card titleKey resolves in all three locales', () => {
    const block = categoryBlock();
    const titleKey = /titleKey: '([^']+)'/.exec(block)?.[1];
    const descriptionKey = /descriptionKey: '([^']+)'/.exec(block)?.[1];
    expect(titleKey).toBe('categories.eblastBrand.title');
    expect(descriptionKey).toBe('categories.eblastBrand.description');
    for (const [locale, categories] of [
      ['en', enMessages.admin.settings.index.categories],
      ['th', thMessages.admin.settings.index.categories],
      ['sv', svMessages.admin.settings.index.categories],
    ] as const) {
      expect(categories.eblastBrand.title, `${locale} title`).toBeTruthy();
      expect(categories.eblastBrand.description, `${locale} description`).toBeTruthy();
      // …and not the EN string copied into th/sv (the Latin-only-fallback
      // failure `check:i18n` cannot see, because the key IS present).
      if (locale !== 'en') {
        expect(categories.eblastBrand.title, `${locale} title is untranslated`).not.toBe(
          enMessages.admin.settings.index.categories.eblastBrand.title,
        );
      }
    }
  });
});
