# คู่มือ: ส่งอีเมลกลุ่ม / E-Blast — ฝั่งเจ้าหน้าที่ตรวจอนุมัติ (F7)

> **ใครใช้:** เจ้าหน้าที่สิทธิ์ **admin** เป็นผู้ตรวจ/อนุมัติ/ปฏิเสธ broadcast (manager **ดูได้อย่างเดียว** อนุมัติ/ปฏิเสธ/ยกเลิกไม่ได้)
> **เมนู:** Broadcasts (`/admin/broadcasts`) · Broadcast settings (`/admin/settings/broadcasts`)
> **UAT ของ flow นี้:** [../../uat/admin/broadcasts.uat.md](../../uat/admin/broadcasts.uat.md)

---

## ⚠️ ก่อนเริ่ม — สิ่งที่ต้องมี

1. ระบบ F7 ต้องเปิดอยู่ (`FEATURE_F7_BROADCASTS=true`) — ถ้าปิด สมาชิกจะเขียน broadcast ใหม่ไม่ได้ แต่รายการที่ค้างอยู่ admin ยังตรวจให้จบได้
2. มีบริษัทสมาชิก (member) ที่อยู่ในแพ็กเกจที่มีโควต้า E-Blast (`eblast_per_year > 0`) และมี **primary contact email** ครบ — สมาชิกที่ไม่มีอีเมลติดต่อหลักจะ submit ไม่ได้ (ระบบบล็อกพร้อม deep-link ให้ไปเติมโปรไฟล์)
3. ตั้งค่า Resend Broadcasts ฝั่งระบบให้พร้อม (env: `RESEND_BROADCASTS_API_KEY`, `RESEND_BROADCASTS_WEBHOOK_SECRET`, `UNSUBSCRIBE_TOKEN_SECRET`, `BROADCASTS_FROM_EMAIL`) — ปกติทีมระบบตั้งไว้แล้ว
4. **ฟีเจอร์ขั้นสูง (F7.1a) เปิดเป็น sub-flag แยก** — ถ้าปิดอยู่ เมนู/หน้าจะขึ้น 404:
   - **Templates** (`/admin/broadcasts/templates`) ต้องเปิด `FEATURE_F71A_US7_*`
   - **Broadcast settings → image allowlist** (`/admin/settings/broadcasts`) ต้องเปิด `FEATURE_F71A_US2_*`
   - **Per-batch breakdown / retry** (สำหรับรายชื่อ >10,000) ต้องเปิด `FEATURE_F71A_US1_PAGINATION` — SweCham ~131 ราย ปกติไม่แตะ path นี้

---

## ภาพรวมสถานะ broadcast (จำให้แม่น)

```
[Draft] ──Submit──► [Submitted] ──Approve & send now──► [Approved] ─► [Sending] ─► [Sent]
ร่าง (สมาชิกเขียน)   รอตรวจ        (admin อนุมัติ)        อนุมัติแล้ว   กำลังส่ง     ส่งแล้ว
แก้ได้ (เฉพาะร่าง)    │           └─Approve & schedule─► [Approved + scheduled_for] ─(cron ถึงเวลา)─► [Sending]
                     │
                     ├─Reject (ใส่เหตุผล)──► [Rejected]   คืนโควต้าให้สมาชิก
                     └─Cancel (API-only ใน MVP)─► [Cancelled] คืนโควต้าให้สมาชิก
                                                                  │
                                                  ส่งไม่สำเร็จ 1 ชม.─► [Failed to dispatch]  คงโควต้าจองไว้
```

**กฎสำคัญของ state machine:**
- ยกเลิก (Cancel) ได้ **จนถึงสถานะ Approved เท่านั้น** — เมื่อขยับเป็น **Sending แล้วยกเลิกไม่ได้** (Resend รับงานไปแล้ว)
- เนื้อหา (subject / body / audience / เวลาส่ง) **แก้ได้เฉพาะตอนเป็น Draft** เท่านั้น — เมื่อ submit แล้ว **immutable** จะแก้ไม่ได้ทั้งฝั่งสมาชิกและฝั่ง admin
- admin **แก้เนื้อหาแทนสมาชิกไม่ได้** — ถ้ามีพิมพ์ผิด/ลิงก์เสีย ให้ **Reject พร้อมเหตุผล** เพื่อให้สมาชิกแก้แล้ว submit ใหม่
- **โควต้า:** จอง (reserve) ตอน Submitted, ตัดจริง (consume) ตอน **Sent** เท่านั้น — Reject / Cancel / Failed = คืนโควต้าให้สมาชิก

> 🔴 **จุดที่ย้อนไม่ได้คือ Approve & send now / cron ที่ถึงเวลา** — ทันทีที่ระบบเรียก Resend สำเร็จ (สถานะ Sending) อีเมลถูกส่งเข้ากล่องผู้รับแล้ว ดึงกลับไม่ได้ ตรวจเนื้อหา + รายชื่อผู้รับให้ชัวร์ก่อนอนุมัติ

---

## ภาพรวมหน้าที่ของ admin (สมาชิกเขียนเอง — admin คือด่านตรวจ)

สมาชิกเป็นผู้ **เขียน + เลือกกลุ่มผู้รับ + กด Submit** เองจาก portal (`/portal/benefits?tab=broadcasts`). หน้าที่หลักของ admin คือ:

1. ดูคิวที่รอตรวจ → เปิดดูเนื้อหา + กลุ่มผู้รับ + จำนวนผู้รับโดยประมาณ
2. **Approve & send now** (ส่งทันที) หรือ **Approve & schedule** (ตั้งเวลาส่งล่วงหน้า) หรือ **Reject** (พร้อมเหตุผล)
3. เคลียร์ **halt** เมื่อสมาชิกถูกระบบระงับอัตโนมัติจาก complaint-rate สูง
4. (ขั้นสูง) ดูแล **Templates** และ **image allowlist** สำหรับฝัง URL รูปในเนื้อหา

---

## งานที่ 1 — ตรวจคิวและอนุมัติส่งทันที (Approve & send now)

**สถานการณ์:** สมาชิกส่ง E-Blast เข้าคิวรอตรวจ admin ตรวจแล้วอนุมัติให้ส่งทันที

1. ไปที่เมนู **Broadcasts** (`/admin/broadcasts`) — โดย default หน้านี้กรองแสดงเฉพาะสถานะ **Awaiting review** (submitted) เรียงเก่าสุดขึ้นก่อน
   - แถบบนสุดแสดง **Target review SLA: 48 hours** + ค่า median / p95 ของรอบ 30 วัน เป็นข้อมูลอ้างอิง (ไม่บังคับ ไม่มี auto-escalation)
2. คลิกแถวรายการเพื่อเปิดหน้า **Broadcast review** — ตรวจ:
   - **Subject** + **Message** (เนื้อหาที่ผ่าน sanitiser แล้ว แสดงผลจริงแบบที่ผู้รับจะเห็น)
   - **Audience** (กลุ่มผู้รับ: All members / By membership tier / Event attendees (last 90 days) / Custom recipient list)
   - **Estimated recipients** (จำนวนผู้รับโดยประมาณ — หักผู้ที่ unsubscribe และหักตัวสมาชิกผู้ส่งเองออกแล้วสำหรับกลุ่มแบบสมาชิก)
   - **Submitted by** / **Actor role** (Member = สมาชิกส่งเอง / Admin (proxy) = admin ส่งแทน)
   - **Lifecycle timeline** (ประวัติทุกการเปลี่ยนสถานะ)
3. ถ้าเนื้อหาถูกต้อง กดปุ่ม **Approve** (เขียวมีไอคอนถูก) → กล่อง **"Approve this broadcast?"** เปิดขึ้น
4. เลือก **Approve & send now** → กด **Approve**
   - ระบบเปลี่ยนสถานะ **Submitted → Approved → Sending**, เรียก Resend ภายใน ~60 วินาที, ส่งอีเมลแจ้งสมาชิกว่าอนุมัติแล้ว
   - มี toast **"Broadcast approved."**

> ℹ️ **From-name** = "<ชื่อสมาชิกผู้ส่ง> via <ชื่อหอการค้า>" (เช่น "Fogmaker Thailand via SweCham") และ **Reply-To** = primary contact email ของสมาชิกผู้ส่ง — แก้ไม่ได้ (ผู้รับเห็นชัดว่าใครเป็นผู้ส่งในนามหอการค้า และ reply จะวิ่งกลับเข้าอีเมลของสมาชิกผู้ส่งโดยตรง)
> ℹ️ ถ้าเนื้อหา render ไม่ได้ (กล่องแดง **"Body could not be rendered safely"**) ปุ่ม Approve จะถูกบล็อก — แจ้งทีมระบบ อย่าอนุมัติเนื้อหาที่แสดงผลไม่ปลอดภัย

---

## งานที่ 2 — อนุมัติแบบตั้งเวลาส่งล่วงหน้า (Approve & schedule)

**ใช้เมื่อ:** ต้องการให้อีเมลออกในวัน/เวลาที่กำหนด (เช่น เช้าวันอังคารช่วง open-rate สูง)

1. เปิดแถว Submitted → กด **Approve** → กล่องเปิด
2. เลือก **Approve & schedule** → ช่อง **Send at** ปรากฏ
3. เลือกวัน/เวลา (อย่างน้อย **+5 นาที** จากตอนนี้) — เวลาที่กรอกตีความเป็น **Asia/Bangkok** เสมอ (มี help text กำกับ + แสดง preview **"Will be sent on:"**)
4. กด **Approve**
   - สถานะเป็น **Approved** + ตั้ง `scheduled_for` ไว้ (ยังไม่เรียก Resend)
   - **cron handler** ทุก 5 นาที จะหยิบไปส่งเมื่อถึงเวลา → เปลี่ยนเป็น **Sending**

> ℹ️ ระหว่างที่ยังเป็น **Approved (ตั้งเวลา)** broadcast **ยังยกเลิกได้ทางหลังบ้าน** — แต่ใน MVP นี้ **ยังไม่มีปุ่มยกเลิกในหน้าจอ** (มี backend/API + i18n แล้ว แต่ยังไม่มี component ที่ render ปุ่ม Cancel — สถานะเดียวกับ proxy-submit) จึงต้องยกเลิกผ่าน API โดยตรง; เมื่อขยับเป็น Sending แล้วยกเลิกไม่ได้
> ℹ️ ถ้าส่งไม่สำเร็จ (Resend ล่ม) ระบบ retry ภายใน 1 ชม. ถ้ายังไม่ได้ → สถานะ **Failed to dispatch** + แจ้ง admin + แจ้งสมาชิก, โควต้าจองยังคงไว้ (admin re-trigger หรือให้สมาชิกตั้งใหม่)

---

## งานที่ 3 — ปฏิเสธ broadcast (Reject พร้อมเหตุผล)

**ใช้เมื่อ:** เนื้อหาไม่เหมาะ / พิมพ์ผิด / ลิงก์เสีย / ผิด tone หอการค้า

1. เปิดแถว Submitted → กด **Reject** (ปุ่มกรอบแดงมีไอคอนกากบาท) → กล่อง **"Reject this broadcast?"**
2. กรอก **Reason for rejection** (บังคับ ≥1 ตัวอักษรที่ไม่ใช่ช่องว่าง, สูงสุด 2,000 ตัว) — มีตัวนับ "n / 2000"
   - ⚠️ ข้อความเหตุผลนี้จะถูกส่งให้สมาชิก **คำต่อคำ** ในอีเมลแจ้งปฏิเสธ — เขียนสุภาพและชัดเจน
3. กด **Reject**
   - สถานะ **Submitted → Rejected**, คืนโควต้าจองให้สมาชิก, ส่งอีเมลแจ้งสมาชิกพร้อมเหตุผล
   - มี toast **"Broadcast rejected. The member has been notified."**

> สมาชิกแก้แล้วต้อง **สร้างร่างใหม่ + submit ใหม่** (กิน reservation ใหม่) — ไม่มีปุ่มแก้ในตัว (immutable หลัง submit)

---

## งานที่ 4 — อนุมัติหลายรายการพร้อมกัน (Bulk approve)

**ใช้เมื่อ:** มีหลายรายการรอตรวจและตรวจผ่านแล้วทั้งหมด

1. ในหน้า Broadcasts ติ๊ก checkbox หน้าแถวที่ต้องการ (หรือเลือกทั้งหมด) → แถบ **"{n} selected"** ปรากฏ
2. กด **Approve & send selected**
   - สำเร็จทั้งหมด → toast **"All selected broadcasts approved."**
   - บางรายการพลาด (เช่น มี admin อื่นกดไปก่อน) → toast **"{ok} approved, {fail} failed."** — รายการที่พลาดให้กลับไปอนุมัติทีละรายการ

> ⚠️ Bulk approve = **ส่งทันที** ทุกรายการที่เลือก — ใช้เมื่อมั่นใจว่าตรวจครบแล้ว

---

## งานที่ 5 — เคลียร์การระงับสมาชิก (Clear broadcast halt)

**สถานการณ์:** สมาชิกถูกระบบ **ระงับอัตโนมัติ** เพราะ broadcast หนึ่งมี complaint rate เกิน 5% (และมีผู้รับ ≥20 ราย) — แถบแดงบนสุดของหน้า Broadcasts จะแสดง "{n} member(s) are halted from broadcasting"

1. ในแถบแดง หาแถวสมาชิกที่ถูกระงับ (มีลิงก์ไปหน้า member detail + วันที่ "Halted since")
2. ตรวจสาเหตุก่อน (ดู complaint / เนื้อหาที่ก่อปัญหา) แล้วกด **Review + clear halt**
3. กล่อง **"Clear broadcast halt?"** เปิด → **พิมพ์ชื่อบริษัทของสมาชิก** ให้ตรงเพื่อยืนยัน (typed-phrase pattern)
4. กด **Clear halt**
   - คืนสิทธิ์ให้สมาชิก submit ได้อีกครั้ง, มี toast **"Broadcast halt cleared for this member."**

> ℹ️ manager เห็นแถบ halt แต่จะเห็นข้อความ **"Manager role — read-only"** แทนปุ่ม (กดเคลียร์ไม่ได้)
> ℹ️ การระงับนี้ **คงอยู่** ข้ามการ archive / reactivate / เปลี่ยนแพ็กเกจของสมาชิก — ต้องให้ admin เคลียร์เองเท่านั้น

---

## งานที่ 6 — จัดการ Template (ฟีเจอร์ขั้นสูง F7.1a — ต้องเปิด flag)

**ใช้เมื่อ:** อยากเตรียมแม่แบบ E-Blast ให้สมาชิกเลือกใช้ตอนเขียน (เช่น หัว-ท้ายหอการค้า)

1. ในหน้า Broadcasts กดปุ่ม **Templates** (มุมขวาบน) → หน้า `/admin/broadcasts/templates`
   - ฟิลเตอร์: **All** / **Starter only** / **Admin-authored** · template ที่ระบบ seed มาให้จะมีป้าย **Starter**
2. กด **New template** → กรอก **Name** / **Subject** / **Body (HTML)** / **Locale** → กด **Save template** (toast "Template saved.")
   - **Subject** ใส่ `{{chamber_name}}` ได้ (แทนค่าตอนเริ่มร่าง) · **Body** ใช้ `[ข้อความในวงเล็บเหลี่ยม]` เป็น placeholder ให้สมาชิกแก้
3. แก้ template เดิม: กด **Edit** ในแถว → แก้ → Save
   - แก้ **Starter** จะมีแบนเนอร์เตือน "This is a starter template" — การแก้สร้างเวอร์ชันเฉพาะ tenant
   - ⚠️ ร่างที่สมาชิกเริ่มจาก template ไปแล้ว **ไม่ถูกกระทบ** (snapshot semantics)

> ℹ️ ถ้าเมนู Templates ไม่ขึ้น/เข้าแล้ว 404 = sub-flag F7.1a US7 ปิดอยู่ (ไม่ใช่ bug)

---

## งานที่ 7 — ตั้งค่า image allowlist (ฟีเจอร์ขั้นสูง F7.1a — ต้องเปิด flag)

**ใช้เมื่อ:** อนุญาตให้ฝังรูปจากโดเมนที่กำหนดในเนื้อหา E-Blast (F7 MVP ไม่อนุญาต `<img>` เลย — ฟีเจอร์นี้คือ F7.1a)

1. ไปเมนู **Broadcast settings** (`/admin/settings/broadcasts`)
2. ในการ์ด **Image source allowlist** กรอก **Hostname** (เช่น `cdn.example.com` — ตัวพิมพ์เล็ก ASCII มีจุดอย่างน้อย 1 จุด ไม่มี wildcard) → กด **Add hostname**
3. ลบโดเมนที่เพิ่มเอง: กด **Remove** → ยืนยันในกล่อง (โดเมน **Default (locked)** ลบไม่ได้)

> ℹ️ การเปลี่ยน allowlist มีผลกับ compose session ที่เปิดอยู่ภายใน ~60 วินาที
> ℹ️ หน้านี้ **admin เท่านั้น** (manager เข้าไม่ได้) และต้องเปิด sub-flag F7.1a US2 — ไม่เปิดจะ 404

---

## ❓ คำถามที่พบบ่อย / ข้อควรรู้

| คำถาม | คำตอบ |
|---|---|
| admin แก้เนื้อหา/หัวข้อให้สมาชิกได้ไหม? | **ไม่ได้** — immutable หลัง submit; ถ้าผิดให้ **Reject พร้อมเหตุผล** ให้สมาชิกแก้แล้ว submit ใหม่ |
| ยกเลิก broadcast ที่กำลังส่งได้ไหม? | **ไม่ได้** — ยกเลิกได้แค่จนถึง Approved; เมื่อ Sending แล้ว Resend รับไปแล้ว ดึงกลับไม่ได้ |
| โควต้าตัดตอนไหน? | **จอง** ตอน Submitted, **ตัดจริง** ตอน Sent เท่านั้น; Reject/Cancel/Failed = คืนโควต้า |
| ทำไมจำนวนผู้รับน้อยกว่าจำนวนสมาชิก? | ระบบหักผู้ที่ **unsubscribe**, สมาชิกที่ไม่มี primary contact email, และ **ตัวผู้ส่งเอง** ออกจากกลุ่มแบบสมาชิก |
| manager ทำไมไม่เห็นปุ่ม Approve/Reject? | manager เป็นสิทธิ์ **อ่านอย่างเดียว** — เห็นคิว + รายละเอียดได้ แต่ลงมือไม่ได้ (by design); เรียก API ตรงได้ 403 |
| คนรับ unsubscribe แล้วยังได้อีเมลใบเสร็จ/แจ้งเตือนไหม? | ได้ — suppression list ของ F7 คุมเฉพาะ **อีเมลการตลาด** ไม่กระทบ transactional (รีเซ็ตรหัส/ใบเสร็จ/แจ้งต่ออายุ) |
| สมาชิกถูก halt เพราะอะไร แล้วใครเคลียร์? | complaint rate ของ broadcast หนึ่งเกิน 5% (ผู้รับ ≥20) → ระบบ halt อัตโนมัติ; **admin เท่านั้น** เคลียร์ผ่านแถบแดงในหน้า Broadcasts |
| รายชื่อ >5,000 คนต่อ 1 broadcast ส่งได้ไหม? | **ไม่ได้** — เพดาน 5,000 ราย/ฉบับ (กันทั้งตอน submit และตอน dispatch); ให้สมาชิกเลือกกลุ่มที่แคบลง |
| ปุ่ม "Submit on behalf of member" อยู่ไหน? | **ยังไม่ wired ใน MVP นี้** — มีในข้อกำหนด (Q12 admin-proxy) และ backend/route พร้อมแล้ว แต่ยังไม่มี component ที่ render ปุ่มในหน้า Broadcasts — สถานะเดียวกับ Cancel |

---

## 🔴 สรุปสิ่งที่ "ย้อนกลับไม่ได้" (ระวังให้มาก)

1. **Approve & send now** (หรือ cron ที่ถึงเวลาของ Approve & schedule) → เรียก Resend แล้ว อีเมลถึงผู้รับ ดึงกลับไม่ได้ (สถานะ Sending ยกเลิกไม่ได้)
2. **Reject** → ส่งอีเมลแจ้งสมาชิกพร้อมเหตุผล + คืนโควต้า (สถานะ Rejected)
3. **Cancel** (จนถึง Approved) → คืนโควต้า + แจ้งเตือน (สถานะ Cancelled) — **API-only ใน MVP นี้** (ยังไม่มีปุ่มยกเลิกในหน้าจอ; มี backend/API + i18n แล้ว แต่ยังไม่มี component ที่ render ปุ่ม — สถานะเดียวกับ proxy-submit) ต้องยกเลิกผ่าน API โดยตรง
4. **โควต้าที่ consume ตอน Sent** → ตัดไปแล้วของปีนั้น (ไม่ทบไปปีหน้า)
