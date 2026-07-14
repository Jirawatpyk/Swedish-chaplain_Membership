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
 * verified wrong, and let the uniqueness invariant in
 * `tests/unit/lib/thai-postal-data-integrity.test.ts` catch this whole class
 * of bug (a row displaying some OTHER row's name creates a same-parent
 * duplicate) on every future regeneration.
 *
 * SECOND-PASS CROSS-CHECK (058 / PR-B round 2): the uniqueness invariant is a
 * LOWER BOUND — it only fires when a wrong `name_en` happens to collide with
 * a sibling under the SAME parent. A two-row swap, a wrong-but-unique typo,
 * or a collision with a same-named row under a DIFFERENT parent are all
 * invisible to it — and round 1 shipped all three kinds. `crossCheckAgainstV1`
 * below closes that gap the only way two independent, imperfect sources can:
 * for every id where `api/latest` and `api/v1` agree on `name_th` but
 * disagree on `name_en`, the row MUST appear in `ADJUDICATION_TABLE` with a
 * cited reason, or the generator throws. Rows where the two sources disagree
 * on `name_th` too (not the same place any more, just the same numeric id —
 * see `EXPECTED_ID_INSTABILITY`) are a different, already-documented risk
 * class and are excluded from this check by design.
 *
 * This does NOT prove `api/latest` is now exhaustively correct — it cannot
 * catch a mistranslation both sources happen to share. This run found two:
 * `*Suwannakarm` and `*Khao Niphan`, both with a stray leading `*` present in
 * BOTH endpoints identically. Neither was caught by the v1 cross-check (v1
 * agreed with the bug); both were caught by the new punctuation invariant in
 * the integrity test. See `SOURCE.md` § "Residual risk" for the honest
 * statement of what remains unverifiable by either mechanism.
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
 * Provenance per row: Thai RTGS transliteration convention is the constant
 * across all of these — each Thai spelling below has exactly one standard
 * romanisation, so this is mechanical, not a judgement call. `api/v1` is
 * NOT a reliable independent witness here: a fresh fetch (058 / PR-B round 2)
 * found it carries the IDENTICAL row-shift bug for 8 of these 11 rows
 * (`ท่าตะโก`, `ลาดยาว`, `ทุ่งเบญจา`, `บางตีนเป็ด`, `รอบเมือง`, `เกาะขันธ์`,
 * `ควนหนองหงษ์`, `เขาพระทอง`) — it independently confirms only 3
 * (`หนองขุ่น`, `บ่อแร่`, `หนองบอน`). This corrects an over-broad provenance
 * claim an earlier pass of this file made ("cross-checked against v1" for
 * all 11) — see `ADJUDICATION_TABLE` below, which re-asserts and enforces
 * this claim on every regeneration instead of leaving it as prose. Two rows
 * (`เกาะขันธ์`, `ควนหนองหงษ์`) additionally confirmed via postcodebase.com,
 * since v1 shares the bug for those and RTGS transliteration alone (while
 * still mechanical) benefits from a second, non-transliteration source on a
 * tax-invoice-compliance surface.
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
  // --- 058 / PR-B round 2 (2026-07-14): found via the api/v1 cross-check and
  // the punctuation invariant, not the original bug report. See
  // `src/lib/thai-postal/SOURCE.md` § "Critical fix" for the reviewer table.
  {
    id: 110504,
    name_th: 'ปากคลองบางปลากด',
    name_en: 'Pak Khlong Bang Pla Kot',
    note:
      'was showing "Pak Klong Bang Pla Kot" — RTGS renders คลอง as "Khlong", never ' +
      '"Klong" — Phra Samut Chedi, Samut Prakan. Confirmed via the tambon\'s own ' +
      'English Wikipedia article, titled exactly "Pak Khlong Bang Pla Kot".',
  },
  {
    id: 320716,
    name_th: 'ทับใหญ่',
    name_en: 'Thap Yai',
    note:
      'was showing "Thap Ya" (dropped the final "i") — Rattanaburi, Surin. Confirmed ' +
      "via the tambon's own official domain, tabyai.go.th.",
  },
  {
    id: 341404,
    name_th: 'หนองช้างใหญ่',
    name_en: 'Nong Chang Yai',
    note:
      'was showing "Non Chang Yai" — RTGS renders หนอง as "Nong", never "Non" — ' +
      'Muang Sam Sip, Ubon Ratchathani.',
  },
  {
    id: 361401,
    name_th: 'บ้านเจียง',
    name_en: 'Ban Chiang',
    note:
      'was showing "Chao Thong" — swapped with the next row (id 361402), its sibling ' +
      'tambon in the same district. Phakdi Chumphon district (Chaiyaphum) has exactly ' +
      'four tambons — Ban Chiang, Chao Thong, Wang Thong, Laem Thong (English ' +
      'Wikipedia) — confirming the swap rather than merely suggesting it.',
  },
  {
    id: 361402,
    name_th: 'เจาทอง',
    name_en: 'Chao Thong',
    note: 'was showing "Ban Chiang" — the other half of the 361401/361402 swap above.',
  },
  {
    id: 470704,
    name_th: 'สุวรรณคาม',
    name_en: 'Suwannakham',
    note:
      'was showing "*Suwannakarm" — a stray leading "*" AND a wrong RTGS ending (คาม ' +
      'renders as "Kham", not "Karm"). `api/latest` and `api/v1` BOTH carried this ' +
      'identical corruption (see ADJUDICATION_TABLE) — found via the punctuation ' +
      'invariant in the integrity test, not the v1 cross-check. Nikhom Nam Un, Sakon ' +
      'Nakhon; confirmed via postcodebase.com (zip 47270, matches this record exactly).',
  },
  {
    id: 490505,
    name_th: 'หนองเอี่ยน',
    name_en: 'Nong Ian',
    note:
      'was showing "(Nong Ian" — a stray leading "(" — Kham Cha-i, Mukdahan. Confirmed ' +
      'via postal-code listings (zip 49110, matches this record).',
  },
  {
    id: 640708,
    name_th: 'คลองยาง',
    name_en: 'Khlong Yang',
    note:
      'was showing "Khlong Yao" — RTGS renders ยาง ("rubber", the tree) as "Yang"; ' +
      '"Yao" would require the different word ยาว ("long") — Sawankhalok, Sukhothai. ' +
      "Confirmed via the tambon's own municipal domain, klongyang.go.th.",
  },
  {
    id: 671101,
    name_th: 'ทุ่งสมอ',
    name_en: 'Thung Samo',
    note:
      'was showing "Khao Kho" — swapped with the next entry (id 671103), its sibling ' +
      'tambon in the same district. Khao Kho district (Phetchabun) has exactly seven ' +
      'tambons, listing both Khao Kho and Thung Samo as distinct entries (English ' +
      'Wikipedia) — confirming the swap. NOT the same tambon as the other ทุ่งสมอ in ' +
      'Phanom Thuan district, Kanchanaburi (a different parent, unaffected — see ' +
      "SOURCE.md's reviewer table for why the uniqueness invariant missed this row).",
  },
  {
    id: 671103,
    name_th: 'เขาค้อ',
    name_en: 'Khao Kho',
    note:
      'was showing "Thung Samo" — the other half of the 671101/671103 swap above; ' +
      "this is the district's own seat tambon, sharing its name.",
  },
  {
    id: 841505,
    name_th: 'เขานิพันธ์',
    name_en: 'Khao Niphan',
    note:
      'was showing "*Khao Niphan" — a stray leading "*", otherwise correct RTGS. ' +
      '`api/latest` and `api/v1` BOTH carried this identical corruption (see ' +
      'ADJUDICATION_TABLE) — found via the punctuation invariant, not the v1 ' +
      "cross-check. Wiang Sa, Surat Thani; confirmed via the tambon's own municipal " +
      'domain, khaoniphan.go.th, and postcodebase.com (zip 84190, matches exactly).',
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
 * `api/v1` — a legacy, frozen-2022 snapshot, fetched ONLY as an adjudication
 * oracle (see `crossCheckAgainstV1` below), never shipped. File names differ
 * from `api/latest` (`amphure`/`tambon` vs `district`/`sub_district`), and the
 * sub-district parent key is `amphure_id`, not `district_id`.
 */
async function fetchJsonV1<T>(path: string): Promise<T[]> {
  const res = await fetch(`${UPSTREAM}/${REF}/api/v1/${path}.json`);
  if (!res.ok) throw new Error(`v1/${path}: HTTP ${res.status}`);
  return (await res.json()) as T[];
}
type V1Province = Province;
type V1District = Province & { province_id: number };
type V1SubDistrict = Province & { amphure_id: number; zip_code: number };

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

type Level = 'province' | 'district' | 'sub_district';

type AdjudicationEntry = {
  readonly level: Level;
  readonly id: number;
  readonly name_th: string;
  /** What we ship — `api/latest`, after `applyCorrections` above (if any). */
  readonly latest_en: string;
  /** What `api/v1` says for the same id + name_th. Kept as a drift guard, not shipped. */
  readonly v1_en: string;
  /** Why `latest_en` is trusted over `v1_en`. Must cite evidence, not vibes. */
  readonly reason: string;
};

/**
 * Every id where `api/latest` (post-correction) and `api/v1` agree on
 * `name_th` but disagree on `name_en` MUST have a row here, or
 * `crossCheckAgainstV1` throws — see the SECOND-PASS CROSS-CHECK note at the
 * top of this file. All 18 entries below resolve in favour of `api/latest`;
 * none were left unresolved. If a future disagreement genuinely can't be
 * settled from the two sources plus RTGS/Wikipedia/postcodebase, say so
 * explicitly in `reason` (e.g. `"UNRESOLVED — ..."`) rather than picking one
 * silently — `crossCheckAgainstV1` only requires that the row be looked at
 * and the evidence recorded, not that every case have a confident verdict.
 */
const ADJUDICATION_TABLE: ReadonlyArray<AdjudicationEntry> = [
  {
    level: 'province',
    id: 7,
    name_th: 'ลพบุรี',
    latest_en: 'Lopburi',
    v1_en: 'Loburi',
    reason: 'v1 is missing a "p" — plain typo. RTGS of ลพบุรี is unambiguously "Lopburi".',
  },
  {
    level: 'province',
    id: 77,
    name_th: 'บึงกาฬ',
    latest_en: 'Bueng Kan',
    v1_en: 'buogkan',
    reason:
      'v1 is lowercase, unspaced, and misspelled ("buog" for "bueng") — garbled, not a ' +
      'transliteration variant. "Bueng Kan" is also this province\'s own name.',
  },
  {
    level: 'district',
    id: 2210,
    name_th: 'เขาคิชฌกูฏ',
    latest_en: 'Khao Khitchakut',
    v1_en: 'Khoa Khitchakut',
    reason: 'v1 transposes "ao"→"oa" — typo. Matches English Wikipedia "Khao Khitchakut district".',
  },
  {
    level: 'district',
    id: 3022,
    name_th: 'หนองบุญมาก',
    latest_en: 'Nong Bun Mak',
    v1_en: 'Nong Bunnak',
    reason:
      'v1 carries the district\'s PRE-2003 name — English Wikipedia "Nong Bun Mak ' +
      'district" states it was renamed from "Nong Bunnak" in 2003. v1 is stale, not wrong per se.',
  },
  {
    level: 'district',
    id: 3120,
    name_th: 'โนนดินแดง',
    latest_en: 'Non Din Daeng',
    v1_en: 'Din Daeng',
    reason: 'v1 drops the leading "Non" entirely. Matches English Wikipedia "Non Din Daeng district".',
  },
  {
    level: 'district',
    id: 4125,
    name_th: 'ประจักษ์ศิลปาคม',
    latest_en: 'Prachaksinlapakhom',
    v1_en: 'rachak-sinlapakhom',
    reason:
      'v1 is missing the leading "P", lowercase, and has a stray hyphen — corrupted, not a ' +
      'competing transliteration.',
  },
  {
    level: 'district',
    id: 4405,
    name_th: 'เชียงยืน',
    latest_en: 'Chiang Yuen',
    v1_en: 'Kantharawichai',
    reason:
      'v1 shows a NEIGHBOURING Maha Sarakham district\'s real name (Kantharawichai is a ' +
      'genuine, different district) — a row-shift bug unique to v1. This is the row from ' +
      "the original 058/PR-B brief that turned out NOT to need correcting: latest was " +
      'already right (verified in round 1).',
  },
  {
    level: 'district',
    id: 4520,
    name_th: 'ทุ่งเขาหลวง',
    latest_en: 'Thung Khao Luang',
    v1_en: 'Thung Khao Luangกิ่',
    reason: 'v1 has literal Thai characters appended to the English field — an encoding artefact.',
  },
  {
    level: 'district',
    id: 6008,
    name_th: 'ท่าตะโก',
    latest_en: 'Tha Tako',
    v1_en: 'Takhli',
    reason:
      'v1 carries the SAME row-shift bug as latest\'s pre-correction value (both show ' +
      'ตาคลี\'s (id 6007) name) — v1 does NOT independently confirm this fix, despite an ' +
      'earlier pass of this file claiming so. Evidence is RTGS convention alone: ' +
      'ท่าตะโก is unambiguously "Tha Tako".',
  },
  {
    level: 'district',
    id: 6011,
    name_th: 'ลาดยาว',
    latest_en: 'Lat Yao',
    v1_en: 'Phayuha Khiri',
    reason:
      'v1 carries the SAME row-shift bug (both show พยุหะคีรี\'s (id 6010) name). ' +
      'RTGS-only evidence: ลาดยาว is unambiguously "Lat Yao".',
  },
  {
    level: 'sub_district',
    id: 220309,
    name_th: 'ทุ่งเบญจา',
    latest_en: 'Thung Bencha',
    v1_en: 'Ramphan',
    reason: 'v1 shares the bug (shows รำพัน\'s (id 220311) name). RTGS-only evidence.',
  },
  {
    level: 'sub_district',
    id: 240105,
    name_th: 'บางตีนเป็ด',
    latest_en: 'Bang Tin Pet',
    v1_en: 'Khlong Na',
    reason: 'v1 shares the bug (shows คลองนา\'s (id 240104) name). RTGS-only evidence.',
  },
  {
    level: 'sub_district',
    id: 250102,
    name_th: 'รอบเมือง',
    latest_en: 'Rop Mueang',
    v1_en: 'Na Mueang',
    reason:
      'v1 shares the bug (shows หน้าเมือง\'s (id 250101) name). The other 3 sub-districts ' +
      'nationally named รอบเมือง already say "Rop Mueang".',
  },
  {
    level: 'sub_district',
    id: 470704,
    name_th: 'สุวรรณคาม',
    latest_en: 'Suwannakham',
    v1_en: '*Suwannakarm',
    reason:
      'v1 shares the IDENTICAL corruption (stray "*", wrong "-karm" ending) — this is the ' +
      'residual-risk class this whole cross-check cannot catch (both sources agree on the ' +
      'wrong answer). Found via the punctuation invariant instead; confirmed via ' +
      'postcodebase.com (zip 47270, matches this record).',
  },
  {
    level: 'sub_district',
    id: 800708,
    name_th: 'เกาะขันธ์',
    latest_en: 'Ko Khan',
    v1_en: 'Khuan Nong Hong',
    reason:
      'v1 shares the bug (shows the next row\'s (id 800709) name). Confirmed via ' +
      'postcodebase.com.',
  },
  {
    level: 'sub_district',
    id: 800709,
    name_th: 'ควนหนองหงษ์',
    latest_en: 'Khuan Nong Hong',
    v1_en: 'Khao Phra Thong',
    reason: 'v1 shares the bug (shows the next row\'s (id 800710) name). Confirmed via postcodebase.com.',
  },
  {
    level: 'sub_district',
    id: 800710,
    name_th: 'เขาพระทอง',
    latest_en: 'Khao Phra Thong',
    v1_en: 'Nang Long',
    reason: 'v1 shares the bug (shows the next row\'s (id 800711) name). RTGS + chain position.',
  },
  {
    level: 'sub_district',
    id: 841505,
    name_th: 'เขานิพันธ์',
    latest_en: 'Khao Niphan',
    v1_en: '*Khao Niphan',
    reason:
      'v1 shares the IDENTICAL corruption (stray leading "*") — same residual-risk class ' +
      'as สุวรรณคาม above. Found via the punctuation invariant; confirmed via the ' +
      "tambon's own municipal domain khaoniphan.go.th and postcodebase.com (zip 84190, " +
      'matches exactly).',
  },
];

/**
 * Count of ids where `api/latest` and `api/v1` disagree on `name_th` too —
 * i.e. the id no longer denotes the same administrative unit in the two
 * datasets, so there is no "which English translation is right" question to
 * adjudicate. Overwhelmingly one story: Bueng Kan province (est. 2011, carved
 * out of Nong Khai) had its sub-district numbering revised after v1's 2022
 * snapshot — id 380101 is `คำนาดี` in latest but `บึงกาฬ` in v1, a totally
 * different tambon, not a mistranslation of the same one. `api/latest`'s own
 * name_th/name_en pairing for these rows is internally self-consistent and
 * RTGS-correct (spot-checked); since shipped data only ever uses `latest`'s
 * own id→content mapping, this class of drift cannot corrupt what we ship —
 * it only means v1 can't adjudicate these ids. Pinned so a future upstream
 * renumbering (more of the country, not just Bueng Kan) fails loudly instead
 * of silently growing this blind spot. See `SOURCE.md` § "id-instability".
 */
const EXPECTED_ID_INSTABILITY = {
  province: 0,
  district: 0,
  sub_district: 51,
} as const;

/**
 * Cross-checks one admin level's corrected `api/latest` rows against
 * `api/v1`. Every `name_en` disagreement on a shared `name_th` must be in
 * `ADJUDICATION_TABLE`, or this throws — see the SECOND-PASS CROSS-CHECK note
 * at the top of this file. Also throws on a STALE table entry (one that no
 * longer disagrees — upstream may have fixed `v1`, or a correction changed
 * what we ship) and on the id-instability count drifting from its pin, using
 * the same "silently doing nothing is worse than not doing it" philosophy as
 * `applyCorrections`.
 */
function checkLevel<
  T extends { readonly id: number; readonly name_th: string; readonly name_en: string },
  V extends {
    readonly id: number;
    readonly name_th: string;
    readonly name_en: string;
    readonly deleted_at: string | null;
  },
>(
  level: Level,
  latestRows: readonly T[],
  v1RowsRaw: readonly V[],
  expectedIdInstability: number,
): void {
  const v1ById = new Map(v1RowsRaw.filter((r) => r.deleted_at === null).map((r) => [r.id, r]));
  const adjudicationById = new Map(
    ADJUDICATION_TABLE.filter((a) => a.level === level).map((a) => [a.id, a]),
  );
  const seenAdjudicationIds = new Set<number>();
  let idInstabilityCount = 0;

  for (const row of latestRows) {
    const v1Row = v1ById.get(row.id);
    if (!v1Row) continue; // no v1 counterpart to compare against — see SOURCE.md on missing rows
    if (row.name_en === v1Row.name_en) continue; // agree — nothing to adjudicate

    if (row.name_th !== v1Row.name_th) {
      idInstabilityCount++;
      continue;
    }

    const entry = adjudicationById.get(row.id);
    if (!entry) {
      throw new Error(
        `[thai-postal] UNADJUDICATED disagreement: ${level} id=${row.id} (${row.name_th}) — ` +
          `api/latest says "${row.name_en}", api/v1 says "${v1Row.name_en}". Research which is ` +
          'correct (RTGS convention, English Wikipedia "List of tambon in Thailand", ' +
          'postcodebase.com) and add a row to ADJUDICATION_TABLE recording the decision and ' +
          'evidence — or, if v1 turns out to be right, add a correction to the CORRECTIONS ' +
          'table above instead. Do not silently pick one.',
      );
    }
    if (
      entry.name_th !== row.name_th ||
      entry.latest_en !== row.name_en ||
      entry.v1_en !== v1Row.name_en
    ) {
      throw new Error(
        `[thai-postal] adjudication entry drifted: ${level} id=${row.id} — table says ` +
          `name_th="${entry.name_th}" latest="${entry.latest_en}" v1="${entry.v1_en}", but the ` +
          `fetch now shows name_th="${row.name_th}" latest="${row.name_en}" v1="${v1Row.name_en}". ` +
          're-verify before updating the table.',
      );
    }
    seenAdjudicationIds.add(row.id);
  }

  for (const entry of adjudicationById.values()) {
    if (!seenAdjudicationIds.has(entry.id)) {
      throw new Error(
        `[thai-postal] stale adjudication entry: ${level} id=${entry.id} (${entry.name_th}) no ` +
          'longer disagrees with api/v1 — remove it from ADJUDICATION_TABLE.',
      );
    }
  }

  if (idInstabilityCount !== expectedIdInstability) {
    throw new Error(
      `[thai-postal] id-instability count changed: ${level} = ${idInstabilityCount}, expected ` +
        `${expectedIdInstability}. Upstream likely renumbered more of the country (see ` +
        'SOURCE.md § "id-instability") — re-verify before updating this pin.',
    );
  }
}

async function crossCheckAgainstV1(
  provinces: readonly Province[],
  districts: readonly District[],
  subDistricts: readonly SubDistrict[],
): Promise<void> {
  const [v1Provinces, v1Districts, v1SubDistricts] = await Promise.all([
    fetchJsonV1<V1Province>('province'),
    fetchJsonV1<V1District>('amphure'),
    fetchJsonV1<V1SubDistrict>('tambon'),
  ]);

  checkLevel('province', provinces, v1Provinces, EXPECTED_ID_INSTABILITY.province);
  checkLevel('district', districts, v1Districts, EXPECTED_ID_INSTABILITY.district);
  checkLevel('sub_district', subDistricts, v1SubDistricts, EXPECTED_ID_INSTABILITY.sub_district);

  console.log(
    `[thai-postal] v1 cross-check OK — ${ADJUDICATION_TABLE.length} disagreements adjudicated, ` +
      `${EXPECTED_ID_INSTABILITY.sub_district} sub-district id-instability rows excluded ` +
      '(Bueng Kan renumbering)',
  );
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

  await crossCheckAgainstV1(provinces, districts, subDistricts);

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
