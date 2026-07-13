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
| Retrieved | 2026-07-13 |

This is the same dataset cited by the **Source & Notes** sheet of the reviewer-supplied `docs/import/Thailand_Postal_Codes_Province_District.xlsx`, which is why the cross-check below is an independent oracle rather than a circular one.

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

`data.json` SHA-256: `e89c9820179373b1035e67d9965bfd9bfab781b8fa1205901a81c182c4f8609a`

Pinned by `tests/unit/lib/thai-postal-data-integrity.test.ts` so a hand-edit is caught. If you regenerate, update the hash there **and** here in the same commit.
