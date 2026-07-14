import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `data.json` is GENERATED (scripts/generate-thai-postal-data.ts) and committed.
 * If you regenerate it, update this hash and `src/lib/thai-postal/SOURCE.md`
 * in the same commit. A failure here means someone hand-edited the dataset,
 * OR the upstream content changed and the generator needs re-running (and
 * possibly the correction table in the generator needs re-checking).
 */
const EXPECTED_SHA256 =
  'd3bad3387b73d865cbfba4cff9ae73f8a433fa1119e56430082e29ba2a6021f1';

/**
 * Genuine RTGS homographs: two DIFFERENT Thai names that both correctly
 * transliterate to the SAME English string. This is not a data bug — do NOT
 * add an entry here to silence a failure without manually verifying (against
 * the Thai, and ideally an independent source) that both sides are actually
 * distinct places that happen to romanize identically. See PR-B critical fix
 * (058 / thai-postal English-name corruption) for how this list was built.
 *
 * Key = `${parentNameEn}::${nameEn}`.
 */
const DISTRICT_HOMOGRAPH_ALLOWLIST: ReadonlySet<string> = new Set([
  // Phra Nakhon Si Ayutthaya province: บางไทร AND บางซ้าย both romanize to
  // "Bang Sai" — two different districts, not a duplicate-row bug.
  'Phra Nakhon Si Ayutthaya::Bang Sai',
]);

const SUBDISTRICT_HOMOGRAPH_ALLOWLIST: ReadonlySet<string> = new Set([
  // Fang district (Chiang Mai): แม่คะ AND แม่ข่า both romanize to "Mae Kha"
  // — two different sub-districts (different postal codes), not a
  // duplicate-row bug.
  'Fang::Mae Kha',
]);

type PostalData = {
  readonly provinces: ReadonlyArray<readonly [string, string]>;
  readonly districts: ReadonlyArray<readonly [string, string, number]>;
  readonly byZip: Readonly<Record<string, ReadonlyArray<readonly [string, string, number]>>>;
};

function loadData(): PostalData {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), 'src/lib/thai-postal/data.json'), 'utf8'),
  ) as PostalData;
}

describe('thai-postal data.json', () => {
  it('matches the checksum recorded in SOURCE.md', () => {
    const bytes = readFileSync(resolve(process.cwd(), 'src/lib/thai-postal/data.json'));
    const actual = createHash('sha256').update(bytes).digest('hex');

    expect(actual).toBe(EXPECTED_SHA256);
  });

  /**
   * Below this line: invariants about the CONTENTS, not just the bytes. This
   * is the part that would have caught the PR-B critical bug — a checksum
   * pin alone proves the file wasn't hand-edited, it says nothing about
   * whether upstream shipped a corrupted English-name column. See
   * `scripts/generate-thai-postal-data.ts`'s CORRECTIONS tables and
   * `SOURCE.md` § "Why api/latest, not api/v1" for the incident this guards
   * against.
   */

  it('every province, district, and sub-district English name is non-empty', () => {
    const data = loadData();

    for (const [th, en] of data.provinces) {
      expect(en.trim(), `province ${th} has an empty/blank English name`).not.toBe('');
    }
    for (const [th, en] of data.districts) {
      expect(en.trim(), `district ${th} has an empty/blank English name`).not.toBe('');
    }
    for (const rows of Object.values(data.byZip)) {
      for (const [th, en] of rows) {
        expect(en.trim(), `sub-district ${th} has an empty/blank English name`).not.toBe('');
      }
    }
  });

  /**
   * Would have caught `"(Nong Ian"` (a stray leading `(`) instantly, without
   * needing a human to notice or a v1 cross-check to happen to disagree. It
   * also caught two rows the v1 cross-check COULDN'T — `"*Suwannakarm"` and
   * `"*Khao Niphan"` — because `api/v1` shared the identical stray-`*`
   * corruption (see `scripts/generate-thai-postal-data.ts` `ADJUDICATION_TABLE`
   * for both). Allows spaces, ASCII letters, periods (none currently used but
   * harmless), apostrophes (none currently used — Thai romanisation doesn't
   * produce them — but harmless if RTGS ever does), and hyphens (real: e.g.
   * "Tha Sa-at").
   */
  it('every English name contains only [A-Za-z .\'-] — no stray punctuation, digits, or Thai characters', () => {
    const data = loadData();
    const ALLOWED = /^[A-Za-z .'-]+$/;

    const unexpected: string[] = [];
    for (const [th, en] of data.provinces) {
      if (!ALLOWED.test(en)) unexpected.push(`province ${th}: "${en}"`);
    }
    for (const [th, en] of data.districts) {
      if (!ALLOWED.test(en)) unexpected.push(`district ${th}: "${en}"`);
    }
    for (const rows of Object.values(data.byZip)) {
      for (const [th, en] of rows) {
        if (!ALLOWED.test(en)) unexpected.push(`sub-district ${th}: "${en}"`);
      }
    }

    expect(
      unexpected,
      `English names with characters outside [A-Za-z .'-] (likely upstream corruption ` +
        `both api/latest and api/v1 share — the v1 cross-check cannot catch this class; see ` +
        `generator CORRECTIONS):\n${unexpected.join('\n')}`,
    ).toEqual([]);
  });

  it('district English names are unique within their province, except the documented RTGS homographs', () => {
    const data = loadData();

    const byProvince = new Map<string, Array<readonly [string, string]>>();
    for (const [th, en, provinceIndex] of data.districts) {
      const province = data.provinces[provinceIndex];
      if (!province) continue;
      const provinceEn = province[1];
      (byProvince.get(provinceEn) ?? byProvince.set(provinceEn, []).get(provinceEn)!).push([
        th,
        en,
      ]);
    }

    const unexpected: string[] = [];
    for (const [provinceEn, rows] of byProvince) {
      const byEn = new Map<string, string[]>();
      for (const [th, en] of rows) {
        (byEn.get(en) ?? byEn.set(en, []).get(en)!).push(th);
      }
      for (const [en, thaiNames] of byEn) {
        const distinctThai = new Set(thaiNames);
        if (distinctThai.size <= 1) continue;
        if (DISTRICT_HOMOGRAPH_ALLOWLIST.has(`${provinceEn}::${en}`)) continue;
        unexpected.push(
          `${provinceEn} / "${en}" shared by Thai names ${JSON.stringify([...distinctThai])}`,
        );
      }
    }

    expect(
      unexpected,
      `unexpected district name_en clashes (likely a row-shift bug — see generator CORRECTIONS):\n${unexpected.join('\n')}`,
    ).toEqual([]);
  });

  it('sub-district English names are unique within their district, except the documented RTGS homographs', () => {
    const data = loadData();

    const byDistrict = new Map<number, Array<readonly [string, string]>>();
    for (const rows of Object.values(data.byZip)) {
      for (const [th, en, districtIndex] of rows) {
        (byDistrict.get(districtIndex) ?? byDistrict.set(districtIndex, []).get(districtIndex)!).push(
          [th, en],
        );
      }
    }

    const unexpected: string[] = [];
    for (const [districtIndex, rows] of byDistrict) {
      const district = data.districts[districtIndex];
      if (!district) continue;
      const districtEn = district[1];

      const byEn = new Map<string, string[]>();
      for (const [th, en] of rows) {
        (byEn.get(en) ?? byEn.set(en, []).get(en)!).push(th);
      }
      for (const [en, thaiNames] of byEn) {
        const distinctThai = new Set(thaiNames);
        if (distinctThai.size <= 1) continue;
        if (SUBDISTRICT_HOMOGRAPH_ALLOWLIST.has(`${districtEn}::${en}`)) continue;
        unexpected.push(
          `${districtEn} / "${en}" shared by Thai names ${JSON.stringify([...distinctThai])}`,
        );
      }
    }

    expect(
      unexpected,
      `unexpected sub-district name_en clashes (likely a row-shift bug — see generator CORRECTIONS):\n${unexpected.join('\n')}`,
    ).toEqual([]);
  });
});
