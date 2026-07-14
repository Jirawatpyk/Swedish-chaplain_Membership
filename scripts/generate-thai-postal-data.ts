/**
 * Regenerates `src/lib/thai-postal/data.json` — the bilingual (TH + EN) Thai
 * postal-code → sub-district / district / province reference table used by the
 * member-form address section (058 / PR-B).
 *
 * This is a ONE-OFF generator, NOT a build step. The generated JSON is
 * committed to the repo, exactly like the Sarabun TTFs under `public/fonts/`.
 * `vercel-build` must never reach out to GitHub: a production deploy that
 * depends on a third-party repo's uptime (and on an unpinned upstream) is a
 * supply-chain and reproducibility hazard. Run this by hand when the upstream
 * publishes a new administrative-division release, then commit the diff and
 * update `src/lib/thai-postal/SOURCE.md` with the new upstream SHA.
 *
 *   pnpm tsx scripts/generate-thai-postal-data.ts
 *
 * Upstream: https://github.com/kongvut/thai-province-data (MIT) — the same
 * dataset cited by the "Source & Notes" sheet of the reviewer-supplied
 * `docs/import/Thailand_Postal_Codes_Province_District.xlsx`, which is why the
 * cross-check in `verify()` below is meaningful rather than circular.
 *
 * SOURCE: `api/latest/`, NOT `api/v1/` — see `src/lib/thai-postal/SOURCE.md`
 * § "Why api/latest, not api/v1" for the evidence. Short version: `api/latest`
 * has a small number of isolated row-shift bugs in `name_en` (a handful of
 * districts/sub-districts show a neighbouring row's English name instead of
 * their own — see CORRECTIONS below), but `api/v1` is a frozen 2022 snapshot
 * that is missing an entire district (กัลยาณิวัฒนา / Galyani Vadhana, Chiang
 * Mai, created 2025), carries ~30 stale postal codes that `api/latest` has
 * since corrected, and has its OWN independent corruption in places `latest`
 * gets right (e.g. province `บึงกาฬ` → "buogkan" in v1 vs the correct "Bueng
 * Kan" in latest). Switching wholesale to v1 would trade one bug class for a
 * worse one on a Thai-tax-invoice-compliance surface. The fix here is
 * therefore surgical: stay on `api/latest`, hand-correct the specific rows
 * verified wrong (each cross-checked against v1, RTGS transliteration
 * convention, and — where those were insufficient — an independent web
 * source), and let the uniqueness invariant in
 * `tests/unit/lib/thai-postal-data-integrity.test.ts` catch this whole class
 * of bug (a row displaying some OTHER row's name creates a same-parent
 * duplicate) on every future regeneration.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const UPSTREAM = 'https://raw.githubusercontent.com/kongvut/thai-province-data';
const REF = 'master';

type Province = {
  id: number;
  name_th: string;
  name_en: string;
  deleted_at: string | null;
};
type District = Province & { province_id: number };
type SubDistrict = Province & { district_id: number; zip_code: number };

/**
 * Hand-verified corrections for rows where `api/latest` shows the wrong
 * `name_en` (each one duplicates a NEIGHBOURING row's English name — a
 * row-shift bug in the upstream pipeline, not a translation dispute).
 *
 * Every correction is keyed on the row's permanent numeric admin `id` (not
 * name alone — `รอบเมือง` alone occurs at 4 different ids nationally, and
 * only one of them is wrong) with `name_th` asserted as a drift guard. If a
 * row is renumbered or removed upstream, `apply()` throws instead of
 * silently doing nothing — see `verify()`.
 *
 * Provenance per row: cross-checked against `api/v1` (frozen 2022 snapshot,
 * which pre-dates whatever introduced the shift in `latest`) AND Thai
 * RTGS transliteration convention. Three rows (`เกาะขันธ์`, `ควนหนองหงษ์`,
 * `หนองบอน`) additionally confirmed via Wikipedia's "List of tambon in
 * Thailand" / postcodebase.com, since `api/v1` was independently wrong or
 * unhelpful for those.
 */
const DISTRICT_CORRECTIONS: ReadonlyArray<{
  readonly id: number;
  readonly name_th: string;
  readonly name_en: string;
  readonly note: string;
}> = [
  {
    id: 6008,
    name_th: 'ท่าตะโก',
    name_en: 'Tha Tako',
    note: 'was showing "Takhli" — the neighbouring district ตาคลี (id 6007) — Nakhon Sawan',
  },
  {
    id: 6011,
    name_th: 'ลาดยาว',
    name_en: 'Lat Yao',
    note: 'was showing "Phayuha Khiri" — the preceding district พยุหะคีรี (id 6010) — Nakhon Sawan',
  },
];

const SUBDISTRICT_CORRECTIONS: ReadonlyArray<{
  readonly id: number;
  readonly name_th: string;
  readonly name_en: string;
  readonly note: string;
}> = [
  {
    id: 220309,
    name_th: 'ทุ่งเบญจา',
    name_en: 'Thung Bencha',
    note: 'was showing "Ramphan" (belongs to รำพัน, id 220311) — Tha Mai, Chanthaburi',
  },
  {
    id: 240105,
    name_th: 'บางตีนเป็ด',
    name_en: 'Bang Tin Pet',
    note: 'was showing "Khlong Na" (belongs to คลองนา, id 240104) — Mueang Chachoengsao',
  },
  {
    id: 250102,
    name_th: 'รอบเมือง',
    name_en: 'Rop Mueang',
    note:
      'was showing "Na Mueang" (belongs to หน้าเมือง, id 250101) — Mueang Prachin Buri. ' +
      'The other 3 sub-districts nationally named รอบเมือง already say "Rop Mueang" correctly.',
  },
  {
    id: 800708,
    name_th: 'เกาะขันธ์',
    name_en: 'Ko Khan',
    note:
      'was showing "Khuan Nong Hong" (belongs to the next row, id 800709) — Cha-uat, ' +
      'Nakhon Si Thammarat. First link of a 3-row shift chain (800708→800709→800710); ' +
      'confirmed via postcodebase.com since v1 has this row identically wrong.',
  },
  {
    id: 800709,
    name_th: 'ควนหนองหงษ์',
    name_en: 'Khuan Nong Hong',
    note: 'was showing "Khao Phra Thong" (belongs to the next row, id 800710) — Cha-uat',
  },
  {
    id: 800710,
    name_th: 'เขาพระทอง',
    name_en: 'Khao Phra Thong',
    note: 'was showing "Nang Long" (belongs to the next row, id 800711) — Cha-uat',
  },
  {
    id: 180306,
    name_th: 'หนองขุ่น',
    name_en: 'Nong Khun',
    note: 'was showing "Bo Rae" (belongs to the next row, id 180307) — Wat Sing, Chai Nat',
  },
  {
    id: 180307,
    name_th: 'บ่อแร่',
    name_en: 'Bo Rae',
    note: 'was showing "Wang Man" (belongs to วังหมัน, id 180311) — Wat Sing, Chai Nat',
  },
  {
    id: 440311,
    name_th: 'หนองบอน',
    name_en: 'Nong Bon',
    note:
      'was showing "Nong Bua" (belongs to the preceding row, id 440308) — Kosum Phisai, ' +
      'Maha Sarakham. The other 4 sub-districts nationally named หนองบอน already say ' +
      '"Nong Bon" correctly.',
  },
];

/** Compact, index-packed shape — see `src/lib/thai-postal/lookup.ts`. */
type PostalData = {
  /** `[name_th, name_en]`, index = province index. */
  readonly provinces: ReadonlyArray<readonly [string, string]>;
  /** `[name_th, name_en, provinceIndex]`, index = district index. */
  readonly districts: ReadonlyArray<readonly [string, string, number]>;
  /** 5-digit postal code → `[sub_district_th, sub_district_en, districtIndex][]`. */
  readonly byZip: Readonly<Record<string, ReadonlyArray<readonly [string, string, number]>>>;
};

async function fetchJson<T>(path: string): Promise<T[]> {
  const res = await fetch(`${UPSTREAM}/${REF}/api/latest/${path}.json`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T[];
}

/**
 * Applies a correction list in place, by numeric `id`. Throws — loudly,
 * failing the whole generation — if a correction's `id` no longer exists, or
 * exists but its `name_th` has drifted, so this stays honest as upstream
 * moves: a correction that silently no-ops is worse than no correction at
 * all, because the next person to read this file assumes it's still doing
 * something.
 */
function applyCorrections<T extends { id: number; name_th: string; name_en: string }>(
  rows: T[],
  corrections: ReadonlyArray<{ readonly id: number; readonly name_th: string; readonly name_en: string }>,
): void {
  for (const c of corrections) {
    const row = rows.find((r) => r.id === c.id);
    if (!row) {
      throw new Error(
        `[thai-postal] correction target vanished: id=${c.id} (${c.name_th}) — ` +
          `upstream renumbered or removed this row; re-verify and update the correction table`,
      );
    }
    if (row.name_th !== c.name_th) {
      throw new Error(
        `[thai-postal] correction key drifted: id=${c.id} now has name_th=` +
          `"${row.name_th}", expected "${c.name_th}" — re-verify before reapplying`,
      );
    }
    row.name_en = c.name_en;
  }
}

/**
 * The reviewer's spreadsheet is the acceptance oracle: it was produced from the
 * same upstream, so if our transform is faithful these four numbers must match
 * it exactly. They are pinned here so a bad upstream release (or a bug in the
 * packing below) fails loudly instead of silently shipping a wrong address book.
 */
const EXPECTED = {
  provinces: 77,
  districts: 930,
  zips: 955,
  /** postal codes that span more than one province (13240, 18220, 22160, …) */
  multiProvinceZips: 8,
} as const;

function verify(data: PostalData): void {
  const zips = Object.keys(data.byZip);
  const multiProvince = zips.filter((z) => {
    const provinces = new Set(
      (data.byZip[z] ?? []).map((s) => data.districts[s[2]]?.[2]),
    );
    return provinces.size > 1;
  });

  const actual = {
    provinces: data.provinces.length,
    districts: data.districts.length,
    zips: zips.length,
    multiProvinceZips: multiProvince.length,
  };

  for (const [key, expected] of Object.entries(EXPECTED)) {
    const got = actual[key as keyof typeof actual];
    if (got !== expected) {
      throw new Error(
        `cross-check failed: ${key} = ${got}, expected ${expected} ` +
          `(reviewer spreadsheet: docs/import/Thailand_Postal_Codes_Province_District.xlsx)`,
      );
    }
  }
  console.log('[thai-postal] cross-check OK', actual);
}

async function main(): Promise<void> {
  const [provincesRaw, districtsRaw, subDistrictsRaw] = await Promise.all([
    fetchJson<Province>('province'),
    fetchJson<District>('district'),
    fetchJson<SubDistrict>('sub_district'),
  ]);

  const live = <T extends { deleted_at: string | null }>(rows: T[]): T[] =>
    rows.filter((r) => r.deleted_at === null);

  const provinces = live(provincesRaw).sort((a, b) => a.id - b.id);
  const districts = live(districtsRaw).sort((a, b) => a.id - b.id);
  const subDistricts = live(subDistrictsRaw);

  applyCorrections(districts, DISTRICT_CORRECTIONS);
  applyCorrections(subDistricts, SUBDISTRICT_CORRECTIONS);

  const provinceIndex = new Map(provinces.map((p, i) => [p.id, i]));
  const districtIndex = new Map(districts.map((d, i) => [d.id, i]));

  const byZip: Record<string, Array<readonly [string, string, number]>> = {};
  for (const s of subDistricts) {
    const di = districtIndex.get(s.district_id);
    if (di === undefined) continue; // sub-district of a deleted district
    const zip = String(s.zip_code).padStart(5, '0');
    (byZip[zip] ??= []).push([s.name_th, s.name_en, di] as const);
  }

  const data: PostalData = {
    provinces: provinces.map((p) => [p.name_th, p.name_en] as const),
    districts: districts.map(
      (d) => [d.name_th, d.name_en, provinceIndex.get(d.province_id)!] as const,
    ),
    byZip: Object.fromEntries(
      Object.keys(byZip)
        .sort()
        .map((z) => [z, byZip[z]!]),
    ),
  };

  verify(data);

  const out = resolve(process.cwd(), 'src/lib/thai-postal/data.json');
  writeFileSync(out, `${JSON.stringify(data)}\n`, 'utf8');
  console.log(`[thai-postal] wrote ${out}`);
}

void main();
