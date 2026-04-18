# Sarabun (Google Fonts)

**Purpose**: Thai typeface embedded into Chamber-OS tax-document PDFs (F4 Invoicing & Thai-Tax Receipts) via `@react-pdf/renderer`. Required by Thai Revenue Department bilingual invoice/receipt conventions; pinned at build-time for deterministic byte-identical re-rendering (spec SC-003).

**Source**: https://github.com/google/fonts/tree/main/ofl/sarabun
**License**: SIL Open Font License, Version 1.1 — see `OFL.txt` in this directory.
**Designer**: Suppakit Chalermlarp (Cadson Demak)

## Weights

| File                  | Weight | Used for                    |
| --------------------- | ------ | --------------------------- |
| `Sarabun-Regular.ttf` | 400    | body, customer block, lines |
| `Sarabun-Medium.ttf`  | 500    | table headers               |
| `Sarabun-Bold.ttf`    | 700    | totals, tax-invoice title   |

## Re-download / upgrade

```bash
cd public/fonts/sarabun
curl -LO https://github.com/google/fonts/raw/main/ofl/sarabun/Sarabun-Regular.ttf
curl -LO https://github.com/google/fonts/raw/main/ofl/sarabun/Sarabun-Medium.ttf
curl -LO https://github.com/google/fonts/raw/main/ofl/sarabun/Sarabun-Bold.ttf
curl -LO https://github.com/google/fonts/raw/main/ofl/sarabun/OFL.txt
```

Any font-file bump requires a new `pdf_template_version` in `template-registry.ts` because re-rendering with a new font changes byte output (FR-016 / SC-003). Pinned renders (e.g. `resend-pdf.ts`, Blob-miss recovery) must use the template version that was in effect at issue time.

## SIL OFL v1.1 summary (full text in `OFL.txt`)

- Free to use, modify, bundle, and redistribute.
- Derivatives using the Reserved Font Name "Sarabun" are not permitted — rename forks.
- The font itself may not be sold standalone; it may be bundled inside a product (like this repo).
- Redistribution must include the licence text and copyright notice.
