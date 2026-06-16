# คู่มือ: ต่ออายุสมาชิก + การแจ้งเตือนอัจฉริยะ (F8)

> **ใครใช้:** เจ้าหน้าที่สิทธิ์ **admin** (manager เห็นทุกหน้าแบบ **อ่านอย่างเดียว** กดปุ่มแก้ไขไม่ได้ ยกเว้นบันทึก outreach ของตัวเอง)
> **เมนู:** **Renewals** (`/admin/renewals`) — ในนั้นมีมุมมอง Pipeline / **Pending review** / แท็บ **Lapsed**; หน้าย่อย **Tier upgrade queue** (`/admin/renewals/tier-upgrades`) · **Escalation tasks** (`/admin/renewals/tasks`); ตั้งค่าตารางเตือนที่ **Settings → Renewals → Reminder schedules** (`/admin/settings/renewals/schedules`)
> **UAT ของ flow นี้:** [../../uat/admin/renewals.uat.md](../../uat/admin/renewals.uat.md)

> **หมายเหตุชื่อปุ่ม:** แอปรองรับ EN/TH/SV — คู่มือนี้อ้างชื่อปุ่มเป็น **ภาษาอังกฤษ** (ค่า default `en.json`) ตามที่เจ้าหน้าที่ใช้งานจริง พร้อมคำอธิบายไทย

---

## ⚠️ ก่อนเริ่ม — สิ่งที่ต้องมี

1. ระบบ F8 ต้องเปิดอยู่ (`FEATURE_F8_RENEWALS=true`)
   - หากปิด: หน้า Renewals จะขึ้นข้อความ **"The renewals workflow is not yet enabled for this chamber."** และหน้าอื่น (cycle detail / tasks / tier-upgrades) จะเป็น **404**
2. สมาชิกที่จะเข้า pipeline ได้ ต้องมี **วันหมดอายุ (`expires_at`)** — มาจากใบแจ้งหนี้ค่าสมาชิกที่ชำระแล้ว (F4) หรือ `joined_at + ระยะเวลาแพ็กเกจ`
   - สมาชิกที่ **ไม่มีวันหมดอายุ** หรือ **ไม่มีวันเข้าร่วม (`joined_at`)** จะ **ไม่ขึ้น** ใน pipeline — ระบบ (cron) **ข้ามให้เงียบ** และบันทึกเฉพาะใน audit trail (`renewal_skipped_no_joined_at`) เท่านั้น (**ไม่มี** ถาด/แบนเนอร์แจ้งใน UI); admin ต้องเติมวันที่ที่ขาดในข้อมูลสมาชิกเอง
3. ตั้ง **Reminder schedules** ของแต่ละ tier ให้พร้อม (admin ทำที่ Settings → Renewals → Reminder schedules) — กำหนดว่าแต่ละ tier จะถูกเตือนที่ T-90/T-60/... ผ่าน Email หรือสร้างเป็น Task
4. ตารางเตือน + การให้คะแนน + การแนะนำอัปเกรด ทำงานผ่าน **cron อัตโนมัติ** (รายวัน/รายสัปดาห์) — งานในหน้านี้คือ "อ่านผลลัพธ์ + ลงมือกับสมาชิกที่ต้องดูแล"
5. การส่งเงินคืน (refund) ในขั้นตอน reject reactivation ต้องมีระบบ **F5 (online payment)** เปิดอยู่ เพราะ F8 เรียกใช้ refund ของ F5

---

## ภาพรวมสถานะรอบต่ออายุ (renewal cycle) — จำให้แม่น

```
[upcoming] ──ถึงรอบเตือน──► [reminded] ──สมาชิกยืนยัน+ออกใบ──► [awaiting_payment]
 รออยู่                     เตือนแล้ว                          รอชำระเงิน
                                                                  │
                                            ชำระสำเร็จ (F5) ──────┤
                                                                  ▼
                                                            [completed] ✅ (สิ้นสุด)
 ใดๆ ──admin ยกเลิก──► [cancelled] (สิ้นสุด)

หมดอายุ + พ้น grace ยังไม่ชำระ ──► [lapsed] (เข้าแท็บ Lapsed; ยังเข้าระบบจ่ายเงินต่ออายุได้)
  └─ สมาชิก lapsed จ่ายเงินสำเร็จ ──► [completed] (auto-reactivate — ค่า default)
        ถ้าสมาชิกถูกตั้ง "บล็อค auto-reactivation" ──► [pending_admin_reactivation]
                                                         รอ admin Approve / Reject
              └─ ครบ 30 วันไม่มี admin ตัดสิน ──► [lapsed] (auto-timeout + คืนเงิน — ลง lapsed ไม่ใช่ cancelled)
```

**แนวคิดสำคัญ**
- **Grace period** (default 14 วัน): หลังหมดอายุยังเข้าถึงสิทธิ์ได้ชั่วคราว และอยู่ในแท็บ **Grace**
- **Lapsed**: พ้น grace แล้วยังไม่ชำระ → สิทธิ์ถูกจำกัด เข้าได้แค่ดูข้อมูลตัวเอง + จ่ายเงินต่ออายุ
- **Frozen price**: ราคาแพ็กเกจถูก "แช่แข็ง" ตอนเปิดรอบ — อีเมลเตือน, หน้าต่ออายุ และใบแจ้งหนี้ใช้ราคาเดียวกันทั้งหมด (เปลี่ยนราคาแพ็กเกจระหว่างรอบ ไม่กระทบรอบที่เปิดอยู่)
- **At-risk score** (0–100): คะแนนเสี่ยงเลิกต่อ คำนวณรายสัปดาห์ แสดงในวิดเจ็ต "At-risk members" (admin เท่านั้น — สมาชิกมองไม่เห็นคะแนนตัวเอง)
- **Tier upgrade suggestion**: ระบบแนะนำสมาชิกที่ "โตเกินแพ็กเกจปัจจุบัน" — admin เป็นคน Accept (ไม่อัปเกรดอัตโนมัติ และมีผล "ที่รอบต่ออายุถัดไป" ไม่ใช่กลางปี)

---

## งานที่ 1 — ดู Renewal pipeline ประจำวัน

**สถานการณ์:** เปิดดูว่าสมาชิกรายไหนใกล้ครบกำหนดต่ออายุใน 90 วันข้างหน้า

1. เปิดเมนู **Renewals** (`/admin/renewals`)
2. ด้านบนมีแท็บความเร่งด่วน (urgency): **T-90 · T-60 · T-30 · T-14 · T-7 · T-0 · Grace · Lapsed** — ตัวเลขในวงเล็บคือจำนวนสมาชิกในช่องนั้น (ค่าเริ่มต้นเปิดที่ **T-30**)
3. แต่ละแถวแสดง: **Tier · Company · Expires · Urgency · Last reminder · Status · Invoice** และเมนูปุ่ม (•••) ขวาสุด
4. กรองตามแพ็กเกจด้วย **tier filter** (มุมขวาบนของตาราง) — เลือก tier เดียว URL จะอัปเดต (บุ๊กมาร์ก/แชร์ลิงก์ได้)
5. รายการเกิน 50 แถว: กด **"Next 50 →"** เพื่อดูหน้าถัดไป (มีข้อความ "Showing first 50" บอกว่ารายการถูกตัด)

> ℹ️ ถ้าไม่มีสมาชิกครบกำหนดเลย จะขึ้นการ์ด **"No renewals due in the next 90 days"** พร้อมลิงก์ **"View all members"**

---

## งานที่ 2 — ส่งอีเมลเตือนทันที (Send reminder now)

**ใช้เมื่อ:** อยากเตือนสมาชิกรายนี้เดี๋ยวนี้ ไม่รอ cron รอบถัดไป

1. ในตาราง pipeline กดปุ่ม (•••) ขวาสุดของแถว → เลือก **"Send reminder"**
2. ระบบส่งอีเมลด้วย use-case เดียวกับ cron (แหล่งเดียว) ในภาษาที่สมาชิกตั้งไว้
3. ดูผลจาก toast:
   - สำเร็จ → **"Reminder sent"** + "Email queued for delivery to <บริษัท>"
   - ส่งซ้ำใบเดิม → **"Already sent <เวลา>"** (กันส่งซ้ำ — idempotent)
   - ถูกข้าม → เช่น "Skipped — member opted out" / "Skipped — email is unverified" / "Skipped — recent outreach already logged"
   - ล้มเหลวชั่วคราว → "Send failed temporarily — automatic retry within 24h" (ระบบ retry เอง — **อย่าใช้วิธี sleep แล้วลองใหม่รัวๆ**)

> ⚠️ **manager** กดปุ่มนี้ได้ (ปุ่มไม่ถูก disable) แต่เมื่อกดแล้ว API จะตอบ **403** + ขึ้น toast **"Not authorized to send"** และไม่ส่งอีเมล (ระบบบันทึก audit `f8_role_violation_blocked` ฝั่งเซิร์ฟเวอร์) — manager เป็นสิทธิ์อ่านอย่างเดียวบน pipeline

---

## งานที่ 3 — เปิดดูรายละเอียดรอบ (Cycle detail)

1. ในตาราง pipeline กดปุ่ม (•••) → **"Open cycle"** (ในแท็บ Lapsed ก็กดปุ่ม (•••) → **"Open cycle"** เช่นกัน — เมนูนี้ยังมี **"Mark contacted"**)
2. หน้า cycle detail แสดงเป็นการ์ด:
   - **Member & plan** — Company (ลิงก์ไปหน้าสมาชิก), Primary contact, Tier, Plan name, **Frozen price / Term / Currency**
   - **Linked invoice** — เลขใบแจ้งหนี้ + สถานะ + ยอด + ลิงก์ **"View invoice"** (ถ้ายังไม่ออกใบ จะอธิบายว่าทำไม)
   - **Period & timeline** — Period from/to, Expires at, Closed at/reason (ถ้าปิดแล้ว)
   - **Activity** — ประวัติการเตือน (Reminder history) + Escalation tasks ของรอบนี้
3. ปุ่มดูข้อมูลเทคนิค (UUID) ซ่อนอยู่ใน **"Show technical IDs"** / **"Show audit timestamps"**

> ℹ️ หน้านี้เป็น **อ่านอย่างเดียว** สำหรับทั้ง admin และ manager — การกระทำต่อรอบทำจากที่อื่น (pipeline / Pending review)

---

## งานที่ 4 — จัดการสมาชิกกลุ่มเสี่ยง (At-risk widget)

**ใช้เมื่อ:** ดูแลสมาชิกที่มีแนวโน้มไม่ต่ออายุ (คะแนนเสี่ยงสูง) ก่อนจะสายเกินไป

วิดเจ็ต **"At-risk members"** อยู่ใต้ตาราง pipeline ในหน้า `/admin/renewals`

1. ด้านบนมีแท็บแบ่งระดับ: **Warning · At risk · Critical** (ค่าเริ่มต้นเปิดที่ **At risk**)
2. แต่ละแถวแสดง: Company · **Risk score** (พร้อม band) · Last computed · ปุ่มจัดการ
3. **Contact** — บันทึกการติดต่อ (admin **และ** manager กดได้)
   - เปิดกล่อง **"Record outreach"** → เลือก **Channel** (Email / Phone call / In-person meeting) → เลือก template (สำหรับ Email) → ใส่ outcome note (ถ้ามี) → กด **"Record outreach"**
   - ผลข้างเคียง: ระบบ **พัก** อีเมลเตือนอัตโนมัติของสมาชิกรายนี้ **7 วัน** (กันชนกับการโทร/นัดของเจ้าหน้าที่)
4. **Snooze** — ซ่อนสมาชิกออกจากวิดเจ็ตชั่วคราว (**admin เท่านั้น** — manager ไม่เห็นปุ่มนี้)
   - กล่อง **"Snooze at-risk member"** → เลือก **7 / 30 / 90 days** → กด **"Confirm snooze"**
   - คะแนนยังคำนวณต่อเบื้องหลัง สมาชิกจะกลับมาเมื่อครบกำหนด snooze

> 🔴 **สมาชิก (member) มองไม่เห็นคะแนนเสี่ยงของตัวเอง** — วิดเจ็ตนี้ admin-only โดยตั้งใจ
> ℹ️ ถ้าระบบ at-risk ถูกปิดฉุกเฉิน (`FEATURE_F8_AT_RISK_DISABLED=true`) วิดเจ็ตขึ้น "At-risk detection is temporarily unavailable." — ส่วนอื่นของ F8 (pipeline/เตือน/อัปเกรด/tasks) ยังทำงานปกติ

---

## งานที่ 5 — รับ/ปฏิเสธคำแนะนำอัปเกรด tier (Tier upgrade queue)

**ใช้เมื่อ:** สมาชิกมียอดธุรกิจ/ยอดชำระสูงพอจะขึ้น tier ที่สูงกว่า

1. เปิด **`/admin/renewals/tier-upgrades`** (admin เท่านั้น — manager/member จะถูก redirect)
2. ตารางแสดง: Member · **Current plan → Suggested plan** · Reason · Status
3. กดปุ่ม (•••) ของแถว → เลือกการกระทำ:
   - **Accept** — กล่องยืนยัน "Accept tier upgrade?" → ระบบ "ไม่เปลี่ยนแพ็กเกจทันที" แต่จะ **มีผลที่รอบต่ออายุถัดไป** + ส่งอีเมลแจ้งสมาชิก + ตั้ง task ตรวจสอบถ้ารอบยังอีก >180 วัน → toast "Tier upgrade accepted"
   - **Dismiss** — กล่องยืนยัน "Dismiss tier upgrade suggestion?" → ปิดคำแนะนำ + **ระงับไม่แนะนำซ้ำ 90 วัน** (ย้อนกลับไม่ได้) → toast "Suggestion dismissed"
   - **Escalate** — ร่างอีเมล outreach ให้ (ไม่ใช่การกระทำทำลาย ไม่มีกล่องยืนยัน) → toast "Outreach drafted"

> 🔴 ระบบ **ไม่อัปเกรดอัตโนมัติ** — ต้อง admin กด Accept เสมอ; และ Accept จะ **ไม่** ออกใบกลางปี (กันสมาชิกตกใจค่าใช้จ่ายกลางรอบ)
> ℹ️ ถ้าไม่มีคำแนะนำ จะขึ้น "No upgrade candidates this week"

---

## งานที่ 6 — เคลียร์คิวงานที่ต้องทำเอง (Escalation tasks)

**ใช้เมื่อ:** มี touchpoint ที่ไม่ใช่อีเมล เช่น โทรหา Premium, นัดพบ Partnership, ตามใบที่ค้าง

1. เปิด **`/admin/renewals/tasks`** (admin + manager ดูได้; ปุ่มจัดการ admin เท่านั้น)
2. กรองด้วยแท็บสถานะ **Open · Done · Skipped**, แท็บมอบหมาย **All · Mine · Unassigned**, ตัวกรอง task type และ overdue
3. ถ้ามีงานเลยกำหนด จะมีแถบสีแดงด้านบน **"X overdue tasks"** (เลยกำหนด >3 วัน) — กดเพื่อกรองเฉพาะที่ค้าง
4. กดปุ่ม (•••) ของแถว → เลือกการกระทำ:
   - **Done** — กล่อง "Mark task done?" ใส่ outcome note (ถ้ามี) → กด **"Mark done"**
   - **Skip** — กล่อง "Skip task?" **ต้องใส่เหตุผล (บังคับ)** → กด **"Skip task"**
   - **Reassign** — กล่อง "Reassign task" เลือกเจ้าหน้าที่อีกคน → กด **"Reassign"**

> ⚠️ **manager** เห็นคิวงานแต่กดทำไม่ได้ — มีข้อความแจ้ง "You're viewing this queue as a manager — only admins can mark tasks done, skip, or reassign them."

---

## งานที่ 7 — อนุมัติ/ปฏิเสธการกลับมาเป็นสมาชิก (Pending review)

**ใช้เมื่อ:** สมาชิก lapsed ที่ถูกตั้ง "บล็อค auto-reactivation" จ่ายเงินต่ออายุแล้ว → ระบบไม่คืนสิทธิ์อัตโนมัติ ต้องรอ admin ตัดสินใจ

1. ในหน้า `/admin/renewals` กดสลับมุมมองไปที่แท็บ **"Pending review"** — เห็นรายการรอบที่สถานะ `pending_admin_reactivation` (Member · Pending since · Expiry)
2. กด **"Review"** เพื่อเปิดหน้า cycle detail ของรายนั้น (admin เท่านั้นจึงเห็นปุ่มจัดการ)
3. บนหน้า cycle detail (กล่อง "Awaiting your decision"):
   - **Approve reactivation** — กล่อง "Approve this reactivation?" → กด **"Approve"** → รอบเป็น completed, คืนสิทธิ์, เก็บเงินที่จ่ายไว้ → toast "Reactivation approved — the membership is now active."
   - **Reject & refund** — กล่อง "Reject and refund this reactivation?" → **ต้องใส่เหตุผล (1–500 ตัวอักษร)** → กด **"Reject & refund"** → ยกเลิกรอบ + **คืนเงินผ่าน F5** + ออกใบลดหนี้ (credit note) อัตโนมัติ → toast "Reactivation rejected and the payment was refunded."

> 🔴 **Reject & refund ย้อนกลับไม่ได้** — ยกเลิกรอบและคืนเงินถาวร (ดูข้อความ "This action cannot be undone.")
> ℹ️ ถ้า admin ไม่ตัดสินใจภายใน 30 วัน ระบบจะเตือน (T-7/T-3/T-1) แล้วระบบจะ **lapse รอบ (→ lapsed, ไม่ใช่ cancelled) + คืนเงินอัตโนมัติ** ให้เอง (timeout ลง lapsed เพื่อให้ยังอยู่ใน re-engagement funnel; การ reject ของ admin เท่านั้นที่ลง cancelled)

---

## งานที่ 8 — ตั้งค่าตารางเตือนรายชั้น (Reminder schedules)

**ใช้เมื่อ:** กำหนด/แก้ว่าแต่ละ tier จะถูกเตือนเมื่อไหร่และอย่างไร

1. ไปที่ **Settings → Renewals → Reminder schedules** (`/admin/settings/renewals/schedules`)
2. เลือกแท็บ tier: **Thai alumni · Start-up · Regular · Premium · Partnership**
3. เพิ่ม/แก้ขั้นตอนเตือน (step): กำหนด **Offset days** (เช่น T-30), **Delivery channel** (**Email** หรือ **Task**), Email template หรือ Task type + Assignee role
   - ปุ่ม: **"Add step" · "Remove step" · "Move step earlier/later" · "Undo"**
4. กด **"Save schedule"** → toast สรุป "Schedule for <tier> saved (+เพิ่ม -ลบ =เท่าเดิม)" — ทุกการแก้ถูกบันทึก audit

> ⚠️ **manager** อ่านได้แต่บันทึกไม่ได้ ("You have read-only access to renewal schedules. Ask an admin to make changes.")
> ℹ️ Partnership/แพ็กเกจหลายปี: อีเมลเตือนค่าต่ออายุยิง **เฉพาะปีสุดท้าย** ก่อนหมดอายุ; งาน task ยิงทุกปีพร้อมป้าย "Year X of Y"

---

## ❓ คำถามที่พบบ่อย / ข้อควรรู้

| คำถาม | คำตอบ |
|---|---|
| สมาชิกไม่ขึ้นใน pipeline? | ตรวจว่ามี **expires_at** และ **joined_at** ครบ; สมาชิก archived / cycle cancelled-lapsed จะไม่ถูกเตือน/ให้คะแนนซ้ำ |
| กด Send reminder แล้วขึ้น "Already sent"? | ปกติ — ระบบกันส่งซ้ำต่อ (member, cycle, step) |
| manager ทำไมกดปุ่มไม่ได้? | manager เป็น **อ่านอย่างเดียว** ทุกหน้า F8 — ยกเว้น **บันทึก outreach** ของตัวเองในวิดเจ็ต at-risk (by design) |
| ทำไมสมาชิกบ่นว่าไม่เห็นคะแนนเสี่ยงของตัวเอง? | ตั้งใจซ่อน — at-risk เป็น admin-only เพื่อไม่ให้สมาชิกท้อ |
| วันที่ในอีเมล/หน้าจอเป็น พ.ศ. หรือ ค.ศ.? | เก็บเป็น ค.ศ. (สากล) เสมอ; แสดง th-TH เป็น พ.ศ. คู่ ค.ศ. (เช่น 15 ส.ค. 2569 (15 August 2026)) |
| Accept tier upgrade แล้วเปลี่ยนแพ็กเกจทันทีไหม? | ไม่ — มีผลที่รอบต่ออายุถัดไป (กันออกใบกลางปี) |
| รายชื่อ pipeline เกิน 50 แถว ดูส่วนที่เหลืออย่างไร? | กด **"Next 50 →"** (มี "Showing first 50" บอกว่าถูกตัด) |
| email_unverified คืออะไร? | อีเมลสมาชิก bounce เกินเกณฑ์ → ระบบพักการเตือนจนกว่าจะอัปเดต+ยืนยันอีเมลใหม่ และสร้าง task ให้ admin ติดต่อช่องทางอื่น |

---

## 🔴 สรุปสิ่งที่ "ย้อนกลับไม่ได้ / ต้องระวัง"

1. **Dismiss tier upgrade** → ปิดคำแนะนำ + ระงับ 90 วัน (ย้อนไม่ได้)
2. **Reject & refund** (Pending review) → ยกเลิกรอบ + คืนเงินถาวร ("cannot be undone")
3. **Skip task** → ต้องใส่เหตุผล และเข้าสถานะ skipped (ปิดงาน)
4. **Approve reactivation** → คืนสิทธิ์ + ปิดรอบเป็น completed
5. **ส่งเงินคืน/แก้การชำระที่ผิด** ต้องทำผ่าน flow ของ F4/F5 — F8 ไม่มีปุ่ม "ยกเลิกการชำระ" เอง
