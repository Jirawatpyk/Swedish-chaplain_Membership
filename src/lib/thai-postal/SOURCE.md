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
| Endpoint (shipped) | `api/latest/{province,district,sub_district}.json` |
| Endpoint (adjudication oracle only, never shipped) | `api/v1/{province,amphure,tambon}.json` |
| Pinned commit | `326c2ebe778fc0c6a26c4b09770e3c2aa97c6be8` (2026-05-25) |
| Retrieved | 2026-07-14 (round 2) |

This is the same dataset cited by the **Source & Notes** sheet of the reviewer-supplied `docs/import/Thailand_Postal_Codes_Province_District.xlsx`, which is why the cross-check below is an independent oracle rather than a circular one.

## Critical fix (058 / PR-B, 2026-07-14): corrupted English district/sub-district names

The address picker stores the **English** province/district/sub-district on `members.province` / `city` / `sub_district`, which get frozen onto the immutable §86/4 buyer address at invoice issue. `api/latest` has a small number of isolated **row-shift bugs**: a handful of rows show a *neighbouring* row's `name_en` instead of their own. Worst confirmed case: postcode `60160` has exactly one district (ท่าตะโก), so the picker's unambiguous-autofill branch silently wrote **"Takhli"** — the *other* Nakhon Sawan district ตาคลี — onto the address instead of the correct "Tha Tako".

Fixed by an explicit, hand-verified correction table in `scripts/generate-thai-postal-data.ts` (`DISTRICT_CORRECTIONS` / `SUBDISTRICT_CORRECTIONS`), keyed on each row's permanent numeric admin `id` with `name_th` asserted as a drift guard, plus a new **uniqueness-within-parent invariant** in `tests/unit/lib/thai-postal-data-integrity.test.ts` that turns any future recurrence of this bug class into a build failure (a row silently borrowing another row's English name creates a same-parent duplicate — see that test for the two known, deliberately-allowlisted RTGS homograph exceptions).

### Why `api/latest`, not `api/v1`

The original brief for this fix called for switching the generator to `api/v1` (frozen at the same pinned commit, but a legacy endpoint whose `name_en` column doesn't exhibit `latest`'s row-shift bug for most rows). **This was investigated and rejected** — switching wholesale to `api/v1` would fix the reported bug class but introduce three worse regressions, confirmed by diffing the two endpoints in full:

1. **`api/v1` is missing an entire district**: กัลยาณิวัฒนา / Galyani Vadhana (Chiang Mai, `district_id` 5025, added to `latest` 2025-11-15). Switching to v1 would make it impossible to select an address in that district at all — worse than a wrong English name, which at least still lets the Thai secondary text guide the admin.
2. **`api/v1`'s postal codes are stale.** It is a frozen 2022 snapshot; `api/latest` has since absorbed ~30 postal-code corrections (e.g. sub-district id `110601` บางเสาธง: zip `10570` in v1, corrected to `10540` in latest). Switching to v1 would silently regress those sub-districts' postcodes.
3. **`api/v1` has its own independent corruption** in places `api/latest` gets right, including at the *province* level: `บึงกาฬ` → `"buogkan"` in v1 vs. the correct `"Bueng Kan"` in latest; `ลพบุรี` → `"Loburi"` (typo) in v1 vs. correct `"Lopburi"` in latest. It also has several district-level values `api/latest` already gets right (e.g. `เชียงยืน` → `"Kantharawichai"` in v1, but `api/latest` already correctly says `"Chiang Yuen"` — this was one of the corrections in the original brief; verification showed `api/latest` did not need it). **Round 2 found this list is much longer than these three examples** — `api/v1` disagrees with `api/latest` on 18 names total once both sides' own corrections are applied, and `api/latest` is right in every single case (see `ADJUDICATION_TABLE` below). `api/v1` is not merely "occasionally wrong" — for the specific row-shift bug class round 1 fixed, it turns out to share the bug more often than not (8 of 11 rows).

`api/latest`'s corruption, by contrast, is narrow and mechanical: a handful of *isolated* rows duplicate a neighbour's `name_en` (confirmed by inspecting adjacent rows by `id` — each wrong value is byte-identical to a nearby row's *correct* value). The fix here is therefore surgical: **stay on `api/latest`**, hand-correct the confirmed-wrong rows (cross-checked against `api/v1`, RTGS transliteration convention, and — for three rows where those were insufficient — an independent web source: Wikipedia's "List of tambon in Thailand" and postcodebase.com), and add the uniqueness invariant as an ongoing safety net. This satisfies the generator's existing 77/930/955/8 cross-check **unchanged and unrelaxed** — no district, postal code, or multi-province count differs from before.

### Correction table (round 1, 11 rows: 2 districts, 9 sub-districts)

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

**Round 1's provenance claim needs a correction of its own.** This section originally stated all 11 rows above were "cross-checked against `api/v1`". A fresh fetch during round 2 found that's only true for 3 of them (หนองขุ่น, บ่อแร่, หนองบอน) — the other 8 (ท่าตะโก, ลาดยาว, ทุ่งเบญจา, บางตีนเป็ด, รอบเมือง, เกาะขันธ์, ควนหนองหงษ์, เขาพระทอง) turn out to carry the **identical** row-shift bug in `api/v1` too, so v1 was never actually an independent witness for those — RTGS transliteration convention (mechanical, not a judgement call, for unambiguous Thai spellings) is the real evidence. See `ADJUDICATION_TABLE` in the generator, which now re-asserts and enforces this on every regeneration instead of leaving it as unchecked prose.

### Round 2 (058 / PR-B, 2026-07-14): the uniqueness invariant is a lower bound, and a second review pass proved it

A second reviewer pass found **7 more wrong sub-district names** that round 1's uniqueness invariant could not have caught, each for a different structural reason:

| Thai | was showing | corrected to | why the uniqueness invariant missed it |
|---|---|---|---|
| เขาค้อ (district เขาค้อ) | Thung Samo | **Khao Kho** | swapped with its sibling ทุ่งสมอ (id 671101) in the *same* district — a swap duplicates nothing, so there's no collision to detect |
| ทุ่งสมอ (district เขาค้อ) | Khao Kho | **Thung Samo** | the other half of the same swap — not caught separately in the original brief, but required: leaving it unfixed while fixing เขาค้อ would have created a NEW duplicate ("Khao Kho" twice) |
| บ้านเจียง (district ภักดีชุมพล) | Chao Thong | **Ban Chiang** | swapped with its sibling เจาทอง — same reasoning as above |
| เจาทอง (district ภักดีชุมพล) | Ban Chiang | **Chao Thong** | other half of the same swap |
| หนองช้างใหญ่ (ม่วงสามสิบ) | Non Chang Yai | **Nong Chang Yai** | a wrong-but-unique typo (RTGS หนอง → "Nong", not "Non") — nothing to collide with |
| หนองเอี่ยน (คำชะอี) | (Nong Ian | **Nong Ian** | a literal stray `(` from upstream — a unique string, no collision |
| ทับใหญ่ (รัตนบุรี) | Thap Ya | **Thap Yai** | a wrong-but-unique typo (dropped the final "i") |
| ปากคลองบางปลากด (พระสมุทรเจดีย์) | Pak Klong Bang Pla Kot | **Pak Khlong Bang Pla Kot** | RTGS renders คลอง as "Khlong", not "Klong" — a wrong-but-unique transliteration error |

Building the `api/v1` cross-check described below (not manual re-reading) additionally surfaced **2 more** rows sharing an identical corruption in *both* `api/latest` and `api/v1` — a stray leading `*`:

| Thai | was showing (both sources) | corrected to | found by |
|---|---|---|---|
| สุวรรณคาม (นิคมน้ำอูน) | \*Suwannakarm | **Suwannakham** | the new punctuation invariant, not the v1 cross-check (v1 shares the bug) |
| เขานิพันธ์ (เวียงสระ) | \*Khao Niphan | **Khao Niphan** | same — punctuation invariant, not v1 |

That's **11 more corrections** (round 1's 11 + round 2's 11 = **22 total**), all independently confirmed via English Wikipedia, official tambon/อบต. domains, or postcodebase.com — see the generator's `SUBDISTRICT_CORRECTIONS` comments for the citation on each row.

### The `api/v1` cross-check: turning "probably fixed" into "every disagreement was looked at"

The uniqueness invariant is a genuine lower bound — proven twice now, first by the chain-shift clusters in round 1, then by the two swaps and three unique typos in round 2. A collision-based check can never see a swap, a cross-parent collision, or a wrong-but-unique value. But a **disagreement between two independent snapshots can** see all three, because a swap, a unique typo, and a cross-parent collision all still produce *some* string that differs from what the other source says for the same Thai name.

So the generator now **also fetches `api/v1`** (`fetchJsonV1`, `api/v1/{province,amphure,tambon}.json`) purely as an adjudication oracle — never shipped, per the "Why `api/latest`, not `api/v1`" reasoning above, which is unchanged by this. For every id where `api/latest` (after `DISTRICT_CORRECTIONS`/`SUBDISTRICT_CORRECTIONS`) and `api/v1` agree on `name_th` but disagree on `name_en`, the row **must** appear in `ADJUDICATION_TABLE` with a cited reason, or `crossCheckAgainstV1()` throws and the generator refuses to write `data.json`. The table also fails loudly if an entry goes **stale** (no longer disagrees — e.g. a future `api/v1` fix) or if a **new, unadjudicated** disagreement appears on the next regeneration. This is the same "silently doing nothing is worse than not doing it" philosophy `applyCorrections` already used for the correction tables themselves.

**Current adjudication table: 18 entries** (2 province, 8 district, 8 sub-district) — every one resolves in favour of `api/latest`, each with a cited reason (RTGS convention, English Wikipedia, an official tambon/อบต. domain, or postcodebase.com). None are left "unresolved" in this pass, but the mechanism supports that explicitly (`reason: "UNRESOLVED — ..."`) if a future disagreement genuinely can't be settled — the requirement is that the row was *looked at*, not that every case has a confident verdict.

Rows where `api/latest` and `api/v1` disagree on `name_th` too (not just `name_en`) are a **different, separately-pinned risk class**, not part of the 18: `EXPECTED_ID_INSTABILITY` (0 province, 0 district, **51 sub-district**). All 51 are Bueng Kan province (est. 2011, carved out of Nong Khai) plus 2 stray rows elsewhere — id `380101` is `คำนาดี` in `api/latest` but `บึงกาฬ` in `api/v1`: a totally different tambon, not a mistranslation of the same one. This is upstream renumbering the province's sub-districts after v1's 2022 snapshot, not a translation dispute — there is no "which English is right" question to adjudicate when the two sources don't even agree on which place the numeric id denotes. `api/latest`'s own name_th/name_en pairing for the Bueng Kan block was spot-checked and is internally self-consistent and RTGS-correct; since shipped data only ever uses `api/latest`'s own id→content mapping, this class of drift cannot corrupt what we ship. If this count changes on a future regeneration, the generator throws — re-verify rather than bump the pin blindly.

### Residual risk

Two independent, complementary mechanisms are now in place, and each has a **known, honestly-stated blind spot**:

- The **uniqueness invariant** (`tests/unit/lib/thai-postal-data-integrity.test.ts`) only fires when a wrong `name_en` *collides* with a sibling under the same parent. It cannot see a swap between two rows, a wrong-but-unique typo, or a collision with a same-named row under a *different* parent.
- The **`api/v1` cross-check** (`crossCheckAgainstV1`, generator) closes most of that gap — a swap, a unique typo, and a cross-parent collision all still typically produce a `name_en` disagreement between the two sources. But it is blind to the one case that matters most on a compliance surface: **a mistranslation both `api/latest` and `api/v1` happen to share.** This is not hypothetical — round 2 found two (`*Suwannakarm`, `*Khao Niphan`). Those were caught only because the new **punctuation invariant** happened to flag the stray `*` both sources carried; a shared error that produces a plausible-looking English string (a wrong-but-plausible RTGS rendering both sources independently got wrong the same way, for instance) would pass all three checks today.

No claim is made that `api/latest`'s `name_en` column is now exhaustively correct. What can be claimed: every disagreement between `api/latest` and `api/v1` on a shared Thai name has been looked at and adjudicated (not just detected and left alone), the specific bug classes both invariants can detect are fixed and will stay fixed under regeneration, and the honest remaining exposure — a shared two-source error — is exactly this narrow and stated plainly, not implied away.

## Cross-check (enforced by the generator — it throws on a mismatch)

| | Upstream | Reviewer spreadsheet |
|---|---|---|
| Provinces | 77 | 77 |
| Districts (อำเภอ/เขต) | 930 | 930 |
| Unique postal codes | 955 | 955 |
| Postal codes spanning >1 province | 8 | 8 |

The spreadsheet stops at district level; the upstream also carries **7,452 sub-districts (แขวง/ตำบล)** keyed by postal code, which is what lets the form auto-fill the sub-district — a mandatory particular of a §86/4 buyer address that the spreadsheet alone could not have supplied.

## Shape

Index-packed to keep the payload small (367 KB raw / 98 KB gzipped):

```jsonc
{
  "provinces": [["กรุงเทพมหานคร", "Bangkok"], …],           // index = province index
  "districts": [["เขตคลองเตย", "Khet Khlong Toei", 0], …],  // [th, en, provinceIndex]
  "byZip": {
    "10110": [["คลองเตย", "Khlong Toei", 32], …]            // [th, en, districtIndex]
  }
}
```

**This file is never imported by client code.** It is read server-side only, behind `/api/geo/postal/[code]` — at 98 KB gzipped it would blow the members-route bundle budget, and an admin form can afford one round-trip on postcode entry.

## Integrity

`data.json` SHA-256: `d3bad3387b73d865cbfba4cff9ae73f8a433fa1119e56430082e29ba2a6021f1`

Pinned by `tests/unit/lib/thai-postal-data-integrity.test.ts` so a hand-edit is caught. That test also enforces a uniqueness-within-parent invariant and an English-name punctuation invariant (see "Critical fix" / "Round 2" above) — content checks, not just a byte check. If you regenerate, update the hash here **and** there in the same commit.
