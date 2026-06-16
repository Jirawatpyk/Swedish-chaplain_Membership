# คู่มือ: วิธีรัน UAT บน Preview (ก่อน Go-Live)

> **เป้าหมาย:** เตรียมแอปบน preview → เดินทดสอบ UAT ทุกชุด → เซ็นรับ → เปิดใช้งานจริง
> **มี 2 ส่วน:** **A) ผู้ดูแลระบบเตรียม preview** (technical, ทำครั้งเดียวต่อรอบ) · **B) ผู้ทดสอบ SweCham เดิน UAT** (ไม่ต้อง technical)
> เอกสารอ้างอิงเต็ม: รายการ env ทั้งหมด → `docs/go-live-readiness.md` §6 · UAT ทุกชุด → [README.md](README.md)

---

## ส่วน A — เตรียม preview (ผู้ดูแลระบบ / ผู้มีสิทธิ์ Vercel)

### A1. Deploy launch candidate เป็น preview
- push branch ที่จะ launch (เช่น `main` หรือ release branch) → Vercel สร้าง **preview deployment** อัตโนมัติ → ได้ URL (ดูใน PR ของ GitHub หรือ Vercel dashboard) เช่น `https://swecham-xxxx.vercel.app`
- หรือสั่ง CLI: `vercel deploy` (ไม่ใส่ `--prod` = เป็น preview)
- ⚠️ **อย่าใช้ production** สำหรับ UAT — ใช้ preview เท่านั้น

### A2. เปิด feature flags (Vercel → Settings → Environment Variables, scope: **Preview**)
ตั้งค่าให้เปิดฟีเจอร์ที่จะทดสอบ:

| flag | ค่า | ใช้กับชุด |
|---|---|---|
| `FEATURE_F3_MEMBERS` | `true` | F3 สมาชิก |
| `FEATURE_F4_INVOICING` | `true` | F4 ใบกำกับภาษี |
| `FEATURE_F5_ONLINE_PAYMENT` | `true` | F5 ชำระออนไลน์ |
| `FEATURE_F6_EVENTCREATE` | `true` | F6 นำเข้า event |
| `FEATURE_F7_BROADCASTS` | `true` | F7 E-Blast |
| `FEATURE_F8_RENEWALS` | `true` | F8 ต่ออายุ |
| `FEATURE_F8_AT_RISK_DISABLED` | `false` | (เปิดการให้คะแนน at-risk) |
| `FEATURE_F9_DASHBOARD` | `true` | F9 แดชบอร์ด/audit/export |
| `EXPORT_DOWNLOAD_TOKEN_SECRET` | _(ตั้งค่า secret)_ | 🔴 **ถ้า F9 เปิดแต่ไม่ตั้งตัวนี้ แอปจะ 500** |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | _(Stripe **test** pk)_ | ฟอร์มบัตรฝั่งสมาชิก (F5) |

- จะทดสอบ F7.1a (template / รูปภาพ / pagination) ค่อยเปิดเพิ่ม: `FEATURE_F71A_US7_TEMPLATES` / `FEATURE_F71A_US2_IMAGES` / `FEATURE_F71A_US1_PAGINATION` = `true`
- 🔴 **env ที่ระบบต้องมีตอนบูต** (เช่น `APP_ALLOWED_ORIGINS`, `TENANT_SLUG`, Stripe/Resend/Neon/Upstash secrets ฯลฯ) — รายการเต็ม + ค่าที่ถูกต้องอยู่ใน `docs/go-live-readiness.md` §6 **อย่าข้าม** (ขาดตัวใดตัวหนึ่ง แอปจะไม่สตาร์ท)

### A3. Stripe test mode (เฉพาะชุด F5 / PromptPay)
- ใช้ Stripe **test** keys
- รัน `stripe listen --forward-to <preview-url>/api/payments/webhook` (หรือ endpoint ตาม config) → เอา **webhook signing secret** ที่ได้ ใส่ env ของ preview
- ใช้บัตรทดสอบของ Stripe (เช่น `4242 4242 4242 4242`) — ไม่ใช่บัตรจริง

### A4. Seed ข้อมูลทดสอบ + บัญชีทดสอบ
- seed สมาชิก/แพ็กเกจ/ใบแจ้งหนี้ทดสอบ (ดู scripts seed / `quickstart`) — 🔴 **ห้ามใช้ข้อมูลสมาชิกจริง** (PII)
- เตรียมบัญชี **admin / manager / member** (จาก `.env.local` ตัวแปร `E2E_*`) → ส่ง **URL + บัญชี** ให้ผู้ทดสอบ

---

## ส่วน B — เดิน UAT (ผู้ทดสอบ SweCham)

1. เปิด **preview URL** ในเบราว์เซอร์ → ล็อกอิน
   - เจ้าหน้าที่ (staff): `/admin/sign-in` · สมาชิก: `/portal/sign-in`
2. เปิดไฟล์ UAT **ทีละชุด** — เริ่มที่ [README.md](README.md) แล้วเลือกชุด (เช่น `admin/invoicing.uat.md`)
3. แต่ละ **TC** (test case):
   - ทำตามคอลัมน์ **"ขั้นตอน"** บนแอปจริง
   - เทียบกับ **"ผลที่คาดหวัง"**
   - ติ๊ก **☐ ผ่าน / ☐ ไม่ผ่าน** + ใส่หลักฐานในช่องหมายเหตุ (เลขเอกสารที่ได้ / ภาพหน้าจอ)
4. **ไม่ผ่าน:** จดอาการ + เลข TC → แจ้งผู้ดูแลระบบ (บันทึกใน `docs/Bug/` หรือเปิด issue) — อย่าเซ็นรับชุดนั้นจนกว่าจะแก้
5. **จบชุด:** กรอกตาราง "สรุปผล" + เซ็นชื่อท้ายไฟล์ → ทำชุดถัดไปจนครบ

> 💡 ทำทีละชุด (ฟีเจอร์เดียวต่อครั้ง) ไม่ต้องทำ 278 TC รวด — เซ็นรับเป็นชุด, ชุดไหนพังก็โฟกัสแก้ชุดนั้น

---

## เมื่อไหร่ = ผ่าน (Go)
ทุกชุดผ่าน + เซ็นครบ (รวมตาราง "การลงนามรับรองรวม" ใน [README.md](README.md)) → **Go** → ผู้ดูแลระบบ `vercel promote` preview → production = go-live จริง

## ใครทำส่วนไหน
| ส่วน | ใคร |
|---|---|
| A (เตรียม preview / flags / Stripe / seed) | ผู้ดูแลระบบ หรือผู้มีสิทธิ์ Vercel — **ทำครั้งเดียวต่อรอบทดสอบ** |
| B (เดิน TC) | **Office / Membership Manager** |
| cosign ชุด F4 (ใบกำกับภาษี §87/VAT) | **ผู้ทำบัญชี / Bookkeeper** |
| เซ็นรับขั้นสุดท้าย (Go/No-Go) | **GM / Executive Director** |

---

## ปัญหาที่พบบ่อย (preview)
| อาการ | สาเหตุ/แก้ |
|---|---|
| เปิดหน้า F9 (dashboard/audit/export) แล้ว **500** | ลืมตั้ง `EXPORT_DOWNLOAD_TOKEN_SECRET` ขณะ `FEATURE_F9_DASHBOARD=true` |
| ฟอร์มบัตร Stripe ไม่ขึ้น | ลืม `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (test pk) |
| จ่ายแล้วใบไม่เปลี่ยนเป็น Paid | webhook ไม่ถึง — เช็ค `stripe listen` + signing secret |
| แอป preview ไม่สตาร์ท / build fail | ขาด env ที่ต้องมีตอนบูต → ดู `docs/go-live-readiness.md` §6 |
| หน้าฟีเจอร์ขึ้น "ยังไม่เปิดใช้งาน" / 404 | flag ของฟีเจอร์นั้นยัง `false` |
