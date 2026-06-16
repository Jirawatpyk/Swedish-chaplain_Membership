# Chamber-OS — คู่มือการใช้งาน (User Guide)

> **กลุ่มผู้ใช้:** เจ้าหน้าที่หอการค้า (admin / manager) และสมาชิก (member) ของ SweCham / TSCC
> **ภาษา:** ไทยเป็นหลัก (กลุ่มผู้ใช้คือเจ้าหน้าที่ไทย + สมาชิกไทย/สวีเดน) — ดู § ภาษา ด้านล่าง
> **สถานะ:** 🟢 _Template_ — flow **F4 ออกใบกำกับภาษี/ใบเสร็จ** เขียนครบเป็นตัวอย่างมาตรฐานแล้ว; flow อื่นรอ generate

---

## คู่มือนี้คืออะไร (และไม่ใช่อะไร)

**ใช่:** คู่มือ "วิธีทำงาน X ทีละขั้น" สำหรับผู้ใช้ปลายทาง — เจ้าหน้าที่ที่ออกใบกำกับภาษี เชิญสมาชิก ส่ง e-blast ฯลฯ และสมาชิกที่ดูสิทธิประโยชน์/จ่ายเงินผ่าน portal

**ไม่ใช่:**
- เอกสารสำหรับนักพัฒนา → ดู `specs/`, `CLAUDE.md`
- คู่มือดูแลระบบ/แก้ปัญหา (incident, cron, env) → ดู `docs/runbooks/**`, `docs/go-live-readiness.md`
- เอกสาร compliance → ดู `docs/compliance/**`

## ความสัมพันธ์กับ UAT (สำคัญ)

คู่มือนี้กับ **UAT test case** (`docs/uat/`) ใช้ **task flow ชุดเดียวกัน**:

```
                ┌──────────────────────────┐
แต่ละฟีเจอร์ →  │  Task flow (ขั้นตอนหลัก)   │
                └─────────┬────────┬───────┘
                          │        │
              คู่มือใช้งาน │        │ UAT test case
        (เล่าเป็นวิธีทำ)  ▼        ▼ (ตาราง ผ่าน/ไม่ผ่าน + เซ็น)
        docs/user-guide/        docs/uat/
```

เขียน flow ครั้งเดียว → ได้ทั้งคู่มือสอนงาน **และ** สคริปต์ทดสอบก่อน go-live (ดู `docs/uat/README.md`)

---

## สารบัญ (admin operational guide)

| ฟีเจอร์ | คู่มือ | UAT | สถานะ |
|---|---|---|---|
| F1 — เข้าสู่ระบบ / สิทธิ์ผู้ใช้ (RBAC) | [admin/auth-rbac.md](admin/auth-rbac.md) | [UAT](../uat/admin/auth-rbac.uat.md) | 🟢 |
| F2 — แพ็กเกจสมาชิก (membership plans) | [admin/membership-plans.md](admin/membership-plans.md) | [UAT](../uat/admin/membership-plans.uat.md) | 🟢 |
| F3 — จัดการสมาชิก + เชิญเข้าระบบ | [admin/members.md](admin/members.md) | [UAT](../uat/admin/members.uat.md) | 🟢 |
| F4 — ออกใบกำกับภาษี / ใบเสร็จ / ใบลดหนี้ | [admin/invoicing.md](admin/invoicing.md) | [UAT](../uat/admin/invoicing.uat.md) | 🟢 (template) |
| F5 — รับชำระออนไลน์ (Stripe / PromptPay) | [admin/online-payment.md](admin/online-payment.md) | [UAT](../uat/admin/online-payment.uat.md) | 🟢 |
| F6 — นำเข้าผู้ร่วมงาน (EventCreate CSV) | [admin/event-import.md](admin/event-import.md) | [UAT](../uat/admin/event-import.uat.md) | 🟢 |
| F7 — ส่งอีเมลกลุ่ม (E-Blast) | [admin/broadcasts.md](admin/broadcasts.md) | [UAT](../uat/admin/broadcasts.uat.md) | 🟢 |
| F8 — ต่ออายุสมาชิก + การแจ้งเตือน | [admin/renewals.md](admin/renewals.md) | [UAT](../uat/admin/renewals.uat.md) | 🟢 |
| F9 — แดชบอร์ด + audit + export | [admin/dashboard.md](admin/dashboard.md) | [UAT](../uat/admin/dashboard.uat.md) | 🟢 |

### คู่มือสมาชิก (member quick-start)
| หัวข้อ | คู่มือ | UAT | สถานะ |
|---|---|---|---|
| เข้าระบบจากอีเมลเชิญ · ดูสิทธิประโยชน์ · จ่ายใบแจ้งหนี้ · โหลดใบเสร็จ · แก้โปรไฟล์ · export ข้อมูล (GDPR) | [member/quick-start.md](member/quick-start.md) | [UAT](../uat/member/quick-start.uat.md) | 🟢 |

---

## ภาษา (language decision)

- คู่มือ/UAT ชุดนี้เขียน **ภาษาไทย** เพราะผู้ใช้จริงคือเจ้าหน้าที่ SweCham (ไทย) และผู้รับรอง UAT เป็นคนไทย — ต่างจากเอกสาร technical ของโปรเจกต์ที่เป็นอังกฤษ (ตาม `CLAUDE.md`) โดยเจตนา
- ตัว **แอปรองรับ 3 ภาษา (EN/TH/SV)** ปุ่มจะแสดงตามภาษาที่ผู้ใช้เลือก คู่มือนี้อ้างชื่อปุ่มเป็น **อังกฤษ** (ค่า default `en.json`) พร้อมคำอธิบายไทย
  - ⚠️ **ต้องยืนยัน:** เจ้าหน้าที่ SweCham จะใช้แอปด้วยภาษาอะไร (EN หรือ TH)? ถ้าใช้ TH ผมจะเปลี่ยนให้อ้างชื่อปุ่มเป็นภาษาไทยทั้งหมด
- ถ้าต้องการเวอร์ชัน **EN / bilingual** สำหรับบอร์ดต่างชาติ บอกได้

## หลักการเขียน (กัน doc rot)
- task-recipe สั้น ทีละขั้น — ไม่ใช่ reference ยาว
- screenshot ให้น้อย (เก่าเร็ว) — ใส่เฉพาะ flow วิกฤต
- อัปเดตคู่ไปกับฟีเจอร์ที่เปลี่ยน; เวอร์ชันตามแอป
