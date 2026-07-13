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
