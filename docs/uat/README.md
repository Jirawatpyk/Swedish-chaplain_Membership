# Chamber-OS — UAT (User Acceptance Testing) ก่อน Go-Live

> **เป้าหมาย:** ให้ผู้รับรองฝั่ง SweCham (คน non-technical) เดินทดสอบ flow จริงบน **preview deploy** ทีละขั้น แล้ว **เซ็นรับรอง** ก่อนเปิดใช้งานจริง (Stage 5 Go/No-Go ใน `docs/go-live-readiness.md`)
> **สถานะ:** 🟢 _Template_ — ชุด **F4 ออกใบกำกับภาษี/ใบเสร็จ** เขียนครบเป็นตัวอย่างมาตรฐานแล้ว

---

## UAT ต่างจาก automated test อย่างไร (ทำไมยังต้องมี)

ระบบมี automated test ครบแล้ว (TDD, 1,400+ tests, golden-path journey specs `tests/e2e/{admin,manager,member}-journey.spec.ts`) — **UAT ไม่ใช่การเขียน test เพิ่ม** แต่คือ:

1. **คนของ SweCham รับรองด้วยตาตัวเอง** ว่าระบบทำงานถูกต้องตามที่ตกลง → เซ็นก่อนเปิดจริง
2. ทดสอบ **ของจริงที่ CI ไม่ครอบ:** Stripe test mode + PromptPay จริง, Resend e-blast จริง, การแสดงผล PDF/ภาษา
3. **ตรวจเชิงกฎหมายด้วยมนุษย์:** ใบกำกับภาษี/เลขรัน §87, VAT, การ export ข้อมูล PDPA

> ✅ นี่เป็น **first launch** (ยังไม่มีผู้ใช้/ข้อมูลจริง — มีแต่ test data) → ทดสอบบน preview ได้เต็มที่ ไม่มี downtime risk

## ที่มาของ test case (ไม่ได้คิดใหม่)

แต่ละ test case แปลงตรงมาจาก:
- **Acceptance Scenarios (AS)** ใน `specs/<feature>/spec.md` ของแต่ละ user story
- **3 persona journeys** (admin/manager/member) ใน `go-live-readiness.md` §4 Stage 1b
- **Success Criteria (SC)** ที่วัดผลได้
- **task flow ชุดเดียว** กับคู่มือใช้งาน `docs/user-guide/` (เขียนครั้งเดียว ใช้สองที่)

---

## วิธีใช้เอกสารชุดนี้

> 📘 **ขั้นตอนละเอียด (deploy preview + เซ็ต flags + เดิน UAT + เซ็นรับ):** [how-to-run-uat.md](how-to-run-uat.md) — สำหรับทั้งผู้ดูแลระบบ (เตรียม preview) และผู้ทดสอบ SweCham

1. ผู้รับรองเปิด **preview deploy URL** (ไม่ใช่ production) ด้วยบัญชีทดสอบที่กำหนด
2. เดินทีละ **TC (Test Case)** ตามขั้นตอน → เทียบ "ผลที่คาดหวัง"
3. ทำเครื่องหมาย **ผ่าน / ไม่ผ่าน** + ใส่หมายเหตุ/หลักฐาน (เลขเอกสารที่ได้, ภาพหน้าจอ) ในช่องท้ายแต่ละ TC
4. เมื่อครบทุกชุด → ลงนามใน § การลงนามรับรอง (ของแต่ละไฟล์ + สรุปรวม)

**บัญชีทดสอบ** (จาก `.env.local` / preview): admin, manager, member — ขอจากผู้ดูแลระบบก่อนเริ่ม

---

## สารบัญ UAT

| ชุด | ไฟล์ | จำนวน TC | สถานะ |
|---|---|---|---|
| F1 — เข้าระบบ / สิทธิ์ผู้ใช้ | [admin/auth-rbac.uat.md](admin/auth-rbac.uat.md) | 28 | 🟢 |
| F2 — แพ็กเกจสมาชิก | [admin/membership-plans.uat.md](admin/membership-plans.uat.md) | 26 | 🟢 |
| F3 — สมาชิก + เชิญเข้าระบบ | [admin/members.uat.md](admin/members.uat.md) | 36 | 🟢 |
| F4 — ออกใบกำกับภาษี/ใบเสร็จ/ใบลดหนี้/ยกเลิก | [admin/invoicing.uat.md](admin/invoicing.uat.md) | 15 | 🟢 (template) |
| F5 — รับชำระออนไลน์ (card/PromptPay) | [admin/online-payment.uat.md](admin/online-payment.uat.md) | 22 | 🟢 |
| F6 — นำเข้าผู้ร่วมงาน CSV | [admin/event-import.uat.md](admin/event-import.uat.md) | 30 | 🟢 |
| F7 — ส่งอีเมลกลุ่ม (E-Blast) | [admin/broadcasts.uat.md](admin/broadcasts.uat.md) | 25 | 🟢 |
| F8 — ต่ออายุ + แจ้งเตือน | [admin/renewals.uat.md](admin/renewals.uat.md) | 38 | 🟢 |
| F9 — แดชบอร์ด + audit + export | [admin/dashboard.uat.md](admin/dashboard.uat.md) | 36 | 🟢 |
| สมาชิก (member quick-start) | [member/quick-start.uat.md](member/quick-start.uat.md) | 28 | 🟢 |

---

## การลงนามรับรองรวม (Go/No-Go)

| บทบาท | ชื่อ (กรอกก่อน Stage 5) | ผ่านทุกชุด? | วันที่ | ลายเซ็น |
|---|---|---|---|---|
| ผู้รับรอง UAT — เจ้าของอำนาจ (SweCham) | _[General Manager / Executive Director — TBD]_ | ☐ | | |
| ผู้เดินทดสอบ (hands-on) | _[Office / Membership Manager — TBD]_ | ☐ | | |
| ผู้ยืนยันชุด F4 ภาษี | _[ผู้ทำบัญชี / Bookkeeper — TBD]_ | ☐ | | |
| ผู้ดูแลระบบ (technical) | _[TBD]_ | ☐ | | |

> 🟡 **PLACEHOLDER — ต้องกำหนดตัวจริงก่อน Stage 5:** แทนที่ `[… — TBD]` ด้วยชื่อจริงของเจ้าหน้าที่ SweCham (อ้างอิง `go-live-readiness.md` §8 — ยัง OPEN). รูปแบบแนะนำ: GM/Exec Director เซ็นรับแทนองค์กร · Office/Membership Manager เดินทุก TC · ผู้ทำบัญชี cosign เฉพาะชุด F4 (ใบกำกับภาษี/§87/VAT)
