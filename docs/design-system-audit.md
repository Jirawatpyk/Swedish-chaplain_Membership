# Chamber-OS Design System Audit

**Last updated**: 2026-04-24
**Auditor**: ui-design-specialist agent (deep pass)
**Verdict**: ⚠️ **อัพเกรดย่อย** (ไม่ต้องยกเครื่อง) — ระบบแข็งแรงกว่าค่าเฉลี่ย SaaS แต่มี gap เชิงโครงสร้างที่ต้องปิดก่อน F5 ship และก่อนเปิด tenant ที่ 2

> เอกสารนี้เป็น snapshot สำหรับอ้างอิง — ใช้ประกอบการวางแผน Sprint ไม่ใช่ spec ที่ต้อง implement ตามตัวอักษร

---

## 1. Scope & Method

สำรวจ design system artefacts ปัจจุบัน:

- `src/app/globals.css` — Tailwind v4 CSS-first tokens (OKLCH color space)
- `docs/ux-standards.md` — enterprise UX playbook (§ 15 merge-gate checklist, § 18 container guideline)
- `docs/shadcn-customizations.md` — primitive deviation catalogue
- `src/components/ui/*` (32 primitives), `src/components/shell/*`, `src/components/layout/*`
- `src/i18n/messages/{en,th,sv}.json` — ~1190 keys × 3 locales

ประเมิน 6 มิติหลัก + สแกน 8 ธีมเชิงลึก (Tokens / Primitives / Patterns / A11y / Theming / Content / Commerce / Governance)

---

## 2. Health Score (6 มิติ)

| มิติ | คะแนน | หมายเหตุ |
|---|---|---|
| Design tokens | 8/10 | ครบ (color/typo/spacing/radius/motion/modal/table/form) OKLCH + CSS-first Tailwind v4 สะอาด มี contrast fix (destructive L 0.577→0.49, ring 0.708→0.45) พร้อม comment เหตุผล |
| Component primitives | 8/10 | 32 primitives ครอบคลุมดี มี `docs/shadcn-customizations.md` เป็น discipline gate |
| Layout system | 9/10 | 3-tier container (Table 96 / Form 42 / Detail 72 rem) + `pnpm check:layout` CI gate — ดีกว่าค่าเฉลี่ยอุตสาหกรรม |
| Accessibility | 9/10 | WCAG 2.1 AA pass + 2.2 SC 2.4.11/2.5.8 opportunistic, universal focus ring, reduced-motion global neutralise, skip link, Thai line-height override |
| Theming (light/dark) | 7/10 | ทำดี **แต่ไม่มี tenant theme layer** — primary/brand ยัง hardcode ใน `:root` |
| i18n readiness | 8/10 | EN+TH+SV + Thai diacritic override + line-break loose + `.text-cell-clamp` — SV expansion ไม่มี safeguard ระดับ token |

---

## 3. Gap Inventory (19 Gaps)

**สรุปจำนวน**: P0×6 · P1×9 · P2×4

### A. Design Tokens

| # | Gap | Priority | เหตุผล / Feature ที่ปะทะ |
|---|---|---|---|
| A1 | ไม่มี semantic color tokens (success/warning/info) — มีแค่ `destructive` | **P0** | F5 payment states (succeeded/pending/failed/refunded) ต้องการสีสื่อความหมายทันที |
| A2 | Chart palette เป็น grayscale 5 สี (`chart-1..5`) | P1 | F4 invoice dashboard + F5 payment analytics + F6 benefit quota อ่านไม่ออก |
| A3 | ไม่มี elevation/shadow scale (มีแค่ `--card-shadow` ตัวเดียว) | P1 | Dropdown/Popover/Dialog/Toast ใช้ shadow ต่างระดับกัน |
| A4 | ไม่มี z-index scale token | P1 | F5 PaySheet + sticky header + toast + command palette ซ้อนกัน |
| A5 | ไม่มี spacing scale token (ใช้ Tailwind default ล้วน) | P2 | density mode + responsive compact ทำไม่ได้ |
| A6 | ไม่มี breakpoint / opacity / border-width scale tokens | P2 | ขยาย tenant theme ยาก |

### B. Component Primitives

| # | Gap | Priority | เหตุผล / Feature ที่ปะทะ |
|---|---|---|---|
| B1 | ไม่มี form feedback primitives (FormField wrapper, Progress, Toggle Group, Combobox, DatePicker, FileUpload, Stepper) | **P0** | F5 PaySheet ต้อง Stepper+Progress; F4 import ต้อง FileUpload; F3 filter ต้อง Combobox |
| B2 | ไม่มี status/feedback primitives (StatusDot, StatusBadge, Callout, InlineAlert) | **P0** | invoice/payment states กระจาย 20+ จุด ไม่มี canonical component |
| B3 | ไม่มี data-viz primitives (Stat, Metric, Sparkline, ProgressBar, EmptyChart) | P1 | Admin dashboard F4+F5 ต้องใช้ |
| B4 | ไม่มี Money/Number display primitive (THB/SEK/EUR/USD + Thai amount-in-words + BE/CE split) | **P0** | ถ้าไม่มี primitive เดียว จะเขียนผิด locale/format คนละแบบ |

### C. Patterns

| # | Gap | Priority | เหตุผล |
|---|---|---|---|
| C1 | ไม่มี pattern library เอกสาร (page templates, wizard, bulk action, destructive confirm, export/import, unsaved-changes guard) | **P0** | F5 refund/dispute flow + F4 bulk resend ต้องใช้ทันที |
| C2 | ไม่มี table density / table→card responsive pattern | P1 | Members directory บน mobile horizontal-scroll ยาว (F3 known issue) |

### D. Accessibility

| # | Gap | Priority | เหตุผล |
|---|---|---|---|
| D1 | ไม่มี aria-live region strategy | **P0** | toast sonner ไม่ทำหน้าที่ `role=status` สำหรับ async form/payment result — SR ไม่ได้ยิน "Payment succeeded" |
| D2 | ไม่มี forced-colors (WHCM) / prefers-contrast support | P2 | Windows High Contrast เพี้ยน — enterprise/elderly (Swedish market) |

### E. Theming & Branding

| # | Gap | Priority | เหตุผล |
|---|---|---|---|
| E1 | ไม่มี tenant theme layer — branding (primary color, logo, font) ฝังใน CSS `:root` | **P0** | MTA+STD สัญญา white-label แล้ว (saas-architecture.md) — F4 tenant-invoice-settings มี logo แต่ UI theme ยัง static |
| E2 | ไม่มี dark-mode illustration/logo variant | P2 | empty states ใช้ lucide icon เท่านั้น |

### F. Content & i18n

| # | Gap | Priority | เหตุผล |
|---|---|---|---|
| F1 | ไม่มี voice & tone guideline + error message taxonomy + ICU plural rules | P1 | ~1190 keys × 3 locales แต่ไม่มี style guide — TH "คุณ"/"ท่าน" ปน, SV "du"/formal ไม่มี rule |

### G. Commerce / Money (F5 critical)

| # | Gap | Priority | เหตุผล |
|---|---|---|---|
| G1 | ไม่มี Money/Tax-breakdown/Receipt pattern ที่ share ระหว่าง screen + email + PDF | **P0** | react-email + @react-pdf/renderer + app UI ต้องแสดงตัวเลขเดียวกัน pixel-parity (SC-003) — ตอนนี้แยก code 3 ที่ เสี่ยง divergence |

### H. Governance

| # | Gap | Priority | เหตุผล |
|---|---|---|---|
| H1 | ไม่มี Storybook / visual regression / design token export | P1 | 32 ui + 10 shell + 13 layout primitives แต่ไม่มี catalog — เคยพบ Label `mb-*` หาย (กรณีจริง จาก 006 polish) |

---

## 4. Recommended Roadmap

### Sprint 1 — ก่อน F5 merge (6 P0 ที่กระทบ F5 ตรง ๆ)

| Gap | Deliverable | Est. |
|---|---|---|
| A1 | Semantic color tokens (`--success`, `--warning`, `--info` light+dark + contrast pairs) | 0.5d |
| B1 (subset) | `Stepper`, `Progress`, `ProgressBar` primitives | 1–2d |
| B2 | `StatusBadge` (payment/invoice/member states), `StatusDot`, `InlineAlert` | 1d |
| B4 | `<MoneyAmount>` primitive (currency × locale × BE/CE × Thai words) | 1–2d |
| D1 | aria-live region strategy + wire sonner `role=status` + `<LiveRegion>` helper | 0.5d |
| G1 | Shared `MoneyDisplay` + `TaxBreakdown` + `ReceiptLineItem` ใช้ได้ทั้ง screen + react-email + @react-pdf | 2–3d |

**รวม Sprint 1 ≈ 6–9 วัน**

### Sprint 2 — ก่อน F6 (P0 โครงสร้าง)

- C1 — pattern library docs (`docs/ux-patterns.md`): destructive confirm, bulk action, wizard, unsaved-changes, export/import
- E1 — tenant theme layer: wrap `:root` → `:root, [data-tenant]` + `tenant_theme` table schema + resolver

### Post-F5 / F6–F10 — P1 ชุดใหญ่

- A2 chart palette (semantic 5-color + accessible pairs)
- A3 elevation scale · A4 z-index scale
- B1 (เหลือ) Combobox, DatePicker, FileUpload, FormField wrapper
- B3 data-viz primitives
- C2 table density / responsive transformation
- F1 voice & tone guideline
- H1 Storybook + visual regression

### Later — P2

- A5 spacing scale abstraction · A6 breakpoint/opacity/border tokens
- D2 forced-colors / WHCM support
- E2 dark-mode illustrations

---

## 5. Quick Wins (1–2 วัน ได้ผลทันที)

1. **Tenant theme scope** — เพิ่ม `:root, [data-tenant]` selector + เตรียม override slot ไว้ก่อน แม้ยังไม่มี DB layer (ปลดล็อก F14 โดยไม่บล็อก F5)
2. **4 trust primitives** — `<PaymentStatusBadge>`, `<MoneyAmount>`, `<SecurePaymentBanner>`, `<ReceiptCard>` ใช้ได้ทั้ง F4 + F5
3. **Chart palette semantic** — เติม `--chart-success/warning/danger/info/neutral` + contrast pair (ใช้ใน F8)

---

## 6. Verification Checklist (ก่อนปิด Sprint 1)

- [ ] `--success` / `--warning` / `--info` tokens มี pair ทั้ง light/dark + contrast ≥ 4.5:1
- [ ] `<MoneyAmount>` render เหมือนกัน byte-for-byte ใน screen + email + PDF (SC-003)
- [ ] ทุก `toast.success/error` มี `aria-live=polite/assertive` ตามความเหมาะสม
- [ ] `<StatusBadge>` ใช้ครอบคลุม F4 invoice states + F5 payment states ไม่มี one-off color
- [ ] F5 PaySheet ใช้ `<Stepper>` + `<Progress>` canonical ไม่ reinvent

---

## 7. References

- `docs/ux-standards.md` — enterprise UX playbook (merge-gate checklist)
- `docs/shadcn-customizations.md` — primitive deviation catalogue
- `docs/saas-architecture.md` — MTA+STD white-label scope (drives E1)
- `src/app/globals.css` — current token layer
- `.specify/memory/constitution.md` v1.4.0 — Principle III (Clean Architecture), Principle VI (Inclusive UX)

---

**Next action**: ตัดสินใจว่าจะเริ่ม Sprint 1 ก่อน F5 merge หรือยอมรับ debt แล้ว backport หลัง F5 ship — recommendation คือ **แก้ก่อน F5 merge** เพราะ payment UI + receipt pattern จะอ้าง tokens/primitives เหล่านี้หนาแน่น ถ้า retrofit ทีหลัง churn สูง
