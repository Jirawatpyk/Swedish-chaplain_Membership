# Thai postal reference data — provenance

`data.json` is **generated, committed, and never fetched at build time.** Regenerate with:

```bash
pnpm tsx scripts/generate-thai-postal-data.ts
```

## Upstream

| | |
|---|---|
| Repository | [kongvut/thai-province-data](https://github.com/kongvut/thai-province-data) |
| Licence | MIT |
| Endpoint | `api/latest/{province,district,sub_district}.json` |
| Pinned commit | `326c2ebe778fc0c6a26c4b09770e3c2aa97c6be8` (2026-05-25) |
| Retrieved | 2026-07-14 |

This is the same dataset cited by the **Source & Notes** sheet of the reviewer-supplied `docs/import/Thailand_Postal_Codes_Province_District.xlsx`, which is why the cross-check below is an independent oracle rather than a circular one.

## Critical fix (058 / PR-B, 2026-07-14): corrupted English district/sub-district names

The address picker stores the **English** province/district/sub-district on `members.province` / `city` / `sub_district`, which get frozen onto the immutable §86/4 buyer address at invoice issue. `api/latest` has a small number of isolated **row-shift bugs**: a handful of rows show a *neighbouring* row's `name_en` instead of their own. Worst confirmed case: postcode `60160` has exactly one district (ท่าตะโก), so the picker's unambiguous-autofill branch silently wrote **"Takhli"** — the *other* Nakhon Sawan district ตาคลี — onto the address instead of the correct "Tha Tako".

Fixed by an explicit, hand-verified correction table in `scripts/generate-thai-postal-data.ts` (`DISTRICT_CORRECTIONS` / `SUBDISTRICT_CORRECTIONS`), keyed on each row's permanent numeric admin `id` with `name_th` asserted as a drift guard, plus a new **uniqueness-within-parent invariant** in `tests/unit/lib/thai-postal-data-integrity.test.ts` that turns any future recurrence of this bug class into a build failure (a row silently borrowing another row's English name creates a same-parent duplicate — see that test for the two known, deliberately-allowlisted RTGS homograph exceptions).

### Why `api/latest`, not `api/v1`

The original brief for this fix called for switching the generator to `api/v1` (frozen at the same pinned commit, but a legacy endpoint whose `name_en` column doesn't exhibit `latest`'s row-shift bug for most rows). **This was investigated and rejected** — switching wholesale to `api/v1` would fix the reported bug class but introduce three worse regressions, confirmed by diffing the two endpoints in full:

1. **`api/v1` is missing an entire district**: กัลยาณิวัฒนา / Galyani Vadhana (Chiang Mai, `district_id` 5025, added to `latest` 2025-11-15). Switching to v1 would make it impossible to select an address in that district at all — worse than a wrong English name, which at least still lets the Thai secondary text guide the admin.
2. **`api/v1`'s postal codes are stale.** It is a frozen 2022 snapshot; `api/latest` has since absorbed ~30 postal-code corrections (e.g. sub-district id `110601` บางเสาธง: zip `10570` in v1, corrected to `10540` in latest). Switching to v1 would silently regress those sub-districts' postcodes.
3. **`api/v1` has its own independent corruption** in places `api/latest` gets right, including at the *province* level: `บึงกาฬ` → `"buogkan"` in v1 vs. the correct `"Bueng Kan"` in latest; `ลพบุรี` → `"Loburi"` (typo) in v1 vs. correct `"Lopburi"` in latest. It also has several district-level values `api/latest` already gets right (e.g. `เชียงยืน` → `"Kantharawichai"` in v1, but `api/latest` already correctly says `"Chiang Yuen"` — this was one of the corrections in the original brief; verification showed `api/latest` did not need it).

`api/latest`'s corruption, by contrast, is narrow and mechanical: a handful of *isolated* rows duplicate a neighbour's `name_en` (confirmed by inspecting adjacent rows by `id` — each wrong value is byte-identical to a nearby row's *correct* value). The fix here is therefore surgical: **stay on `api/latest`**, hand-correct the confirmed-wrong rows (cross-checked against `api/v1`, RTGS transliteration convention, and — for three rows where those were insufficient — an independent web source: Wikipedia's "List of tambon in Thailand" and postcodebase.com), and add the uniqueness invariant as an ongoing safety net. This satisfies the generator's existing 77/930/955/8 cross-check **unchanged and unrelaxed** — no district, postal code, or multi-province count differs from before.

### Correction table (11 rows: 2 districts, 9 sub-districts)

| Level | Thai | id | was showing | corrected to | why |
|---|---|---|---|---|---|
| District | ท่าตะโก | 6008 | Takhli | **Tha Tako** | neighbour ตาคลี's (id 6007) name |
| District | ลาดยาว | 6011 | Phayuha Khiri | **Lat Yao** | neighbour พยุหะคีรี's (id 6010) name |
| Sub-district | ทุ่งเบญจา | 220309 | Ramphan | **Thung Bencha** | รำพัน's (id 220311) name |
| Sub-district | บางตีนเป็ด | 240105 | Khlong Na | **Bang Tin Pet** | คลองนา's (id 240104) name |
| Sub-district | รอบเมือง | 250102 | Na Mueang | **Rop Mueang** | หน้าเมือง's (id 250101) name — the other 3 รอบเมือง nationally already say "Rop Mueang" |
| Sub-district | เกาะขันธ์ | 800708 | Khuan Nong Hong | **Ko Khan** | first link of a 3-row shift chain in Cha-uat |
| Sub-district | ควนหนองหงษ์ | 800709 | Khao Phra Thong | **Khuan Nong Hong** | 2nd link of the same chain |
| Sub-district | เขาพระทอง | 800710 | Nang Long | **Khao Phra Thong** | 3rd link — the reported 60160-class bug's sibling |
| Sub-district | หนองขุ่น | 180306 | Bo Rae | **Nong Khun** | บ่อแร่'s (id 180307) name — chained with the row below |
| Sub-district | บ่อแร่ | 180307 | Wang Man | **Bo Rae** | วังหมัน's (id 180311) name |
| Sub-district | หนองบอน | 440311 | Nong Bua | **Nong Bon** | หนองบัว's (id 440308) name — the other 4 หนองบอน nationally already say "Nong Bon" |

The three chain-shift clusters (Cha-uat's 800708→710, Wat Sing's 180306→307) were found by running the new uniqueness invariant against the *uncorrected* data and fixing every clash it reported, not just the ones in the original bug report — the invariant is genuinely a lower bound, and even applying the reported corrections one at a time surfaced two further links each time (see git history of this file's generator for the iterative discovery).

### Residual risk

The uniqueness invariant is a **lower bound**: it only catches a wrong `name_en` when it *collides* with a sibling under the same parent. A row-shift bug where the borrowed name happens to be unique within its parent (or a translation that's simply wrong without duplicating anything) is invisible to this check. No claim is made that `api/latest`'s `name_en` column is now exhaustively correct — only that the specific reported class of bug (and everything the invariant can detect) is fixed and will stay fixed under regeneration.

## Cross-check (enforced by the generator — it throws on a mismatch)

| | Upstream | Reviewer spreadsheet |
|---|---|---|
| Provinces | 77 | 77 |
| Districts (อำเภอ/เขต) | 930 | 930 |
| Unique postal codes | 955 | 955 |
| Postal codes spanning >1 province | 8 | 8 |

The spreadsheet stops at district level; the upstream also carries **7,452 sub-districts (แขวง/ตำบล)** keyed by postal code, which is what lets the form auto-fill the sub-district — a mandatory particular of a §86/4 buyer address that the spreadsheet alone could not have supplied.

## Shape

Index-packed to keep the payload small (367 KB raw / 97 KB gzipped):

```jsonc
{
  "provinces": [["กรุงเทพมหานคร", "Bangkok"], …],           // index = province index
  "districts": [["เขตคลองเตย", "Khet Khlong Toei", 0], …],  // [th, en, provinceIndex]
  "byZip": {
    "10110": [["คลองเตย", "Khlong Toei", 32], …]            // [th, en, districtIndex]
  }
}
```

**This file is never imported by client code.** It is read server-side only, behind `/api/geo/postal/[code]` — at 97 KB gzipped it would blow the members-route bundle budget, and an admin form can afford one round-trip on postcode entry.

## Integrity

`data.json` SHA-256: `a72b5ab688786e4581d15e7a41618a41719030e35b70967fb6c34433d63b9b21`

Pinned by `tests/unit/lib/thai-postal-data-integrity.test.ts` so a hand-edit is caught. That test also enforces a uniqueness-within-parent invariant (see "Critical fix" above) — a content check, not just a byte check. If you regenerate, update the hash here **and** there in the same commit.
