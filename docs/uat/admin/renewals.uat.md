# UAT: ต่ออายุสมาชิก + การแจ้งเตือนอัจฉริยะ (F8)

> **คู่มือ flow นี้:** [../../user-guide/admin/renewals.md](../../user-guide/admin/renewals.md)
> **ที่มา:** `specs/011-renewal-reminders/spec.md` (US1–US6) + Success Criteria + Functional Requirements
> **รันบน:** preview deploy (ไม่ใช่ production) · บัญชี: admin, manager, member

## ก่อนเริ่ม (Preconditions รวม)
- [ ] `FEATURE_F8_RENEWALS=true` (ระบบ F8 เปิด)
- [ ] มีสมาชิกทดสอบหลาย tier (Thai alumni / Regular / Premium / Partnership) ที่มี **expires_at** กระจายในช่วง 0–120 วัน
- [ ] มีสมาชิกอย่างน้อย 1 รายที่ **ไม่มี expires_at** และ 1 รายที่ **ไม่มี joined_at** (สำหรับทดสอบถาดแยก)
- [ ] ตั้ง **Reminder schedules** ครบทั้ง 5 tier (มี step T-30 อย่างน้อย 1 tier)
- [ ] มีสมาชิก lapsed อย่างน้อย 1 ราย และ 1 รายที่ตั้ง `blocked_from_auto_reactivation = true` แล้วจ่ายเงินค้างอยู่ (สำหรับ Pending review)
- [ ] F4 (invoicing) + F5 (online payment) เปิด สำหรับทดสอบ flow ต่ออายุ + refund
- [ ] เตรียม 2 tenant (เช่น `swecham` + tenant ทดสอบ) สำหรับทดสอบ cross-tenant isolation

**วิธีกรอก:** แต่ละ TC ทำเครื่องหมาย ✅ ผ่าน / ❌ ไม่ผ่าน ในช่อง "ผล" + ใส่หลักฐาน (toast ที่ได้/สถานะ/ภาพหน้าจอ) ในช่อง "หมายเหตุ"

---

## TC-REN-01 — Renewal pipeline แสดงสมาชิกใกล้ครบกำหนด
**อ้างอิง:** US1-AS1, SC-007 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิดเมนู **Renewals** (`/admin/renewals`) | หน้า "Renewal pipeline" เปิด เห็นแท็บ urgency T-90…Lapsed + ตาราง |
| 2 | ดูสมาชิกที่ครบกำหนดใน 30 วัน | ขึ้นในแท็บ **T-30** (หรือสั้นกว่า) เรียงตามวันหมดอายุจากใกล้ไปไกล |
| 3 | ดูคอลัมน์แต่ละแถว | มี Tier · Company · Expires · Urgency pill · Last reminder · Status · Invoice · ปุ่ม (•••) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-02 — กรองตาม tier และลิงก์แชร์ได้
**อ้างอิง:** US1-AS2 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เลือก tier filter = **Premium** | ตารางแสดงเฉพาะสมาชิก Premium โดยไม่ reload ทั้งหน้า |
| 2 | ดู URL | มี query param (เช่น `?tier=premium`) — บุ๊กมาร์ก/แชร์ได้ |
| 3 | กรอง tier ที่ไม่มีสมาชิกในหน้าต่างนี้ | ตารางว่างแต่ **ตัวกรองยังอยู่** (ไม่ติดกับดัก empty-state จนคืนตัวกรองไม่ได้) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-03 — แท็บ Lapsed + เหตุผล
**อ้างอิง:** US1-AS3 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | กดแท็บ **Lapsed** | เห็นแถบ "Lapsed members" + รายชื่อสมาชิกที่พ้น grace |
| 2 | ดูคอลัมน์ Reason | มี badge เหตุผล เช่น "Grace expired" / "Payment failed" |
| 3 | กดปุ่ม (•••) → **"Open cycle"** (เมนูนี้ยังมี **"Mark contacted"**) | เปิดหน้า cycle detail ของสมาชิกรายนั้น |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-04 — Pagination "Next 50"
**อ้างอิง:** US1-AS5, FR-046 · **บทบาท:** admin · **เงื่อนไข:** มี >50 แถวในช่องเดียว

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิด urgency ที่มี >50 สมาชิก | เห็น "Showing first 50" + ปุ่ม **"Next 50 →"** |
| 2 | กด "Next 50 →" | ไปหน้าถัดไป โดยคง tier + urgency เดิม |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-05 — Cross-tenant isolation (ห้ามเห็นข้ามองค์กร)
**อ้างอิง:** US1-AS4, SC-006 · **บทบาท:** admin (tenant ทดสอบ)

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ล็อกอิน admin ของ tenant ทดสอบ → เปิด `/admin/renewals` | **ไม่เห็น** สมาชิกของ tenant `swecham` เลย |
| 2 | เปิด cycle detail ด้วย cycleId ของ tenant อื่น (URL hand-craft) | ได้ **404 / not found** (ไม่หลุดข้อมูล) + บันทึก audit cross-tenant probe |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-06 — สมาชิกไม่มี expires_at / joined_at ไม่ขึ้น pipeline
**อ้างอิง:** Edge Cases — cron ข้ามเงียบ + audit `renewal_skipped_no_joined_at` (spec SC-007 ระบุถาด "Members without renewal cycle" แต่ **ยังไม่ build** → ดู `docs/Bug/spec-code-divergence-2026-06-16.md` DV-18) · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ดู pipeline | สมาชิกที่ไม่มี expires_at และไม่มี joined_at **ไม่ปรากฏ** ในตาราง urgency |
| 2 | ตรวจ audit log (F9) ของรอบ cron | การข้ามถูกบันทึกเป็น audit `renewal_skipped_no_joined_at` — **ไม่มี** ถาด/แบนเนอร์ใน UI (สมาชิกถูกข้ามเงียบ); admin ต้องเติมวันที่ที่ขาดในข้อมูลสมาชิกเพื่อให้เข้า pipeline |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-07 — Send reminder now (ส่งทันที)
**อ้างอิง:** US2-AS7, FR-018 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ในแถว pipeline กด (•••) → **"Send reminder"** | toast **"Reminder sent"** + "Email queued for delivery to <บริษัท>" |
| 2 | ตรวจอีเมลปลายทาง (กล่องทดสอบ) | ได้อีเมลในภาษาที่สมาชิกตั้งไว้ พร้อมลิงก์ "Renew now" |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-08 — กดส่งเตือนซ้ำถูกกัน (idempotent)
**อ้างอิง:** US2-AS2, FR-011, SC-008, Edge Cases (concurrent send → 409) · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | กด "Send reminder" ซ้ำในแถวเดิม (step เดียวกัน) | toast **"Already sent <เวลา>"** — ไม่ส่งอีเมลซ้ำ |
| 2 | (ถ้าทดสอบ 2 admin พร้อมกัน) คนที่สอง | ได้ HTTP 409 + toast "Already sent <เวลา>" (ไม่ส่งซ้ำ) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-09 — ข้ามการเตือนเมื่อสมาชิก opt-out / email_unverified
**อ้างอิง:** US2-AS5, FR-012, FR-016, FR-012a · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | สมาชิกที่ opt-out renewal reminders → กด "Send reminder" | toast "Skipped — member opted out" (ยังอยู่ใน pipeline) |
| 2 | สมาชิกที่ email_unverified (bounce เกินเกณฑ์) → กด "Send reminder" | toast "Skipped — email is unverified"; แถวมี hint แจ้งว่าระบบพักการเตือน |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-10 — manager เป็นสิทธิ์อ่านอย่างเดียวบน pipeline
**อ้างอิง:** US1-AS / FR-052a · **บทบาท:** manager

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ล็อกอิน manager → เปิด `/admin/renewals` | เห็นตาราง + วิดเจ็ต at-risk (อ่านได้) |
| 2 | กด (•••) ของแถว → กด **"Send reminder"** | ปุ่ม **ไม่ถูก disable** (กดได้) แต่ API ตอบ **403** + ขึ้น toast **"Not authorized to send"** (ไม่ส่งอีเมล; ระบบบันทึก audit `f8_role_violation_blocked` ฝั่งเซิร์ฟเวอร์) |
| 3 | (ขั้นสูง) ยิง POST `/api/admin/renewals/<cycle>/send-reminder-now` ตรง | ได้ **403** + audit `f8_role_violation_blocked` |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-11 — Cycle detail แสดงข้อมูลรอบครบ
**อ้างอิง:** US1 / FR-021a (frozen price) · **บทบาท:** admin หรือ manager

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิด cycle detail | การ์ด Member & plan, Linked invoice, Period & timeline, Activity |
| 2 | ดู Plan card | แสดง **Frozen price / Term (months) / Currency** (ราคาแช่แข็ง) |
| 3 | ดู Activity | Reminder history + Escalation tasks ของรอบ (ถ้ามี) |
| 4 | กด "Show technical IDs" / "Show audit timestamps" | กางดู UUID + timestamps ได้ |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-12 — At-risk widget แสดง + แบ่ง band
**อ้างอิง:** US4-AS1, FR-029, FR-030 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ในหน้า `/admin/renewals` เลื่อนดูวิดเจ็ต "At-risk members" | เห็นแท็บ Warning · At risk · Critical (ค่าเริ่มต้น At risk) |
| 2 | ดูแถว | Company · Risk score (พร้อม band) · Last computed · ปุ่มจัดการ |
| 3 | ถ้าไม่มีสมาชิกเสี่ยง | ขึ้น "All members healthy this week" |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-13 — Snooze สมาชิกเสี่ยง (admin only)
**อ้างอิง:** US4-AS3, FR-032 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | กด **"Snooze"** บนแถวสมาชิก → เลือก **30 days** → **"Confirm snooze"** | toast "Snoozed for 30 days"; สมาชิกหายจากวิดเจ็ต |
| 2 | รอ snooze หมดอายุ (หรือตรวจ logic) | สมาชิกกลับมาในวิดเจ็ต (คะแนนยังถูกคำนวณเบื้องหลัง) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-14 — Record outreach + พักการเตือน 7 วัน
**อ้างอิง:** US4-AS4, FR-033 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | กด **"Contact"** → เลือก Channel (เช่น Phone call) → ใส่ note → **"Record outreach"** | toast "Outreach recorded" |
| 2 | ลอง "Send reminder" สมาชิกรายเดิมภายใน 7 วัน | ถูกข้าม "Skipped — recent outreach already logged" |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-15 — manager บันทึก outreach ได้ แต่ Snooze ไม่ได้
**อ้างอิง:** FR-052a (manager outreach exception), FR-033 · **บทบาท:** manager

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ล็อกอิน manager → เปิดวิดเจ็ต at-risk | เห็นปุ่ม **"Contact"** แต่ **ไม่เห็นปุ่ม "Snooze"** |
| 2 | กด "Contact" → "Record outreach" | บันทึกสำเร็จ (manager ทำได้ตามข้อยกเว้น) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-16 — สมาชิกมองไม่เห็นคะแนนเสี่ยงตัวเอง
**อ้างอิง:** US4-AS5, FR-034 · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ล็อกอิน member → ลองเข้า `/admin/renewals` | ถูก redirect ออกจาก admin (เข้าไม่ได้) |
| 2 | ตรวจว่าไม่มีหน้า/วิดเจ็ตใดเผยคะแนนเสี่ยงให้สมาชิก | ไม่มีการแสดง risk score แก่ member ที่ใดเลย |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-17 — Tier upgrade queue: Accept
**อ้างอิง:** US5-AS2, FR-039 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิด `/admin/renewals/tier-upgrades` | ตาราง Member · Current plan → Suggested plan · Reason · Status |
| 2 | กด (•••) → **"Accept"** → ยืนยันในกล่อง "Accept tier upgrade?" | toast "Tier upgrade accepted"; สถานะเป็น "Pending apply" |
| 3 | ตรวจว่าแพ็กเกจสมาชิก **ยังไม่เปลี่ยนทันที** | เปลี่ยนที่รอบต่ออายุถัดไป (ไม่ออกใบกลางปี) + สมาชิกได้อีเมลแจ้ง |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-18 — Tier upgrade queue: Dismiss (ระงับ 90 วัน)
**อ้างอิง:** US5-AS3, FR-039 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | กด (•••) → **"Dismiss"** → กล่อง "Dismiss tier upgrade suggestion?" | ข้อความเตือน "suppressed for 90 days. This action cannot be undone." |
| 2 | ยืนยัน | toast "Suggestion dismissed"; สถานะ Dismissed; cron ไม่แนะนำซ้ำ 90 วัน |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-19 — Tier upgrade queue เป็น admin-only
**อ้างอิง:** FR-052a · **บทบาท:** manager (และ member)

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ล็อกอิน manager → เปิด `/admin/renewals/tier-upgrades` | ถูก **redirect** ไป `/admin/renewals` (เข้าคิวอัปเกรดไม่ได้) |
| 2 | ล็อกอิน member → ลองเข้า URL เดียวกัน | เข้าไม่ได้ (redirect/บล็อก) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-20 — Escalation tasks: ดูคิว + แบนเนอร์ overdue
**อ้างอิง:** US6-AS1, US6-AS4, FR-045 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิด `/admin/renewals/tasks` | คิวงานพร้อมแท็บ Open/Done/Skipped, All/Mine/Unassigned, ตัวกรอง task type |
| 2 | ถ้ามีงานเลยกำหนด >3 วัน | แถบบนสุด "X overdue tasks" (กดเพื่อกรองเฉพาะ overdue); แถวที่เกินถูกไฮไลต์ |
| 3 | ดูงานของแพ็กเกจหลายปี | มีป้าย "Year X of Y" แยกปีในรอบเดียวกัน |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-21 — Escalation task: Done
**อ้างอิง:** US6-AS2, FR-044 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | กด (•••) → **"Done"** → กล่อง "Mark task done?" ใส่ outcome note (ถ้ามี) → **"Mark done"** | toast "Task marked done"; งานออกจากแท็บ Open |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-22 — Escalation task: Skip (ต้องมีเหตุผล)
**อ้างอิง:** US6-AS / FR-044 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | กด (•••) → **"Skip"** → กล่อง "Skip task?" **ไม่ใส่เหตุผล** แล้วกดยืนยัน | ถูกบล็อก "A reason is required before you can skip this task." |
| 2 | ใส่เหตุผล → **"Skip task"** | toast "Task skipped"; สถานะ Skipped |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-23 — Escalation task: Reassign
**อ้างอิง:** US6-AS3, FR-044 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | กด (•••) → **"Reassign"** → เลือกเจ้าหน้าที่อีกคน → **"Reassign"** | toast "Task reassigned"; ผู้รับใหม่เห็นงานในแท็บ "Mine" |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-24 — manager เห็นคิว tasks แต่กดทำไม่ได้
**อ้างอิง:** FR-052a · **บทบาท:** manager

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ล็อกอิน manager → เปิด `/admin/renewals/tasks` | เห็นคิว + ข้อความ "only admins can mark tasks done, skip, or reassign them." |
| 2 | (ขั้นสูง) ยิง POST done/skip/reassign ตรง | ได้ 403 ("Only admins can …") |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-25 — Member self-service renewal: token → confirm → pay
**อ้างอิง:** US3-AS1, US3-AS2, US3-AS3, SC-002, SC-009 · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | สมาชิกคลิกลิงก์ "Renew now" จากอีเมล | auto-sign-in + ไป `/portal/renewal/<member_id>` แสดงแพ็กเกจ + frozen price + benefit summary + ปุ่ม "Confirm renewal" |
| 2 | กด "Confirm renewal" | ออกใบแจ้งหนี้ต่ออายุ (F4) ด้วย frozen price + redirect ไปหน้าจ่ายเงิน F5 |
| 3 | จ่ายด้วย test card สำเร็จ (F5) | ใบเป็น paid; **expires_at เลื่อนไป 1 ปี**; รอบเป็น completed; เด้งไปหน้า success (`/portal/renewal/<id>/success` → title "Renewal complete" / subtitle "Thank you — your membership is active.") + ลิงก์ "Download receipt PDF" *(หมายเหตุ: welcome email ของ FR-023 ยัง deferred — ดู tasks.md T123; ถ้าต้องการ ให้ raise เป็น implementation gap ไม่ใช่เกณฑ์ผ่าน UAT)* |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-26 — Member self-service: payment failed → schedule กลับมา
**อ้างอิง:** US3-AS4, FR-024 · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ที่หน้าจ่ายเงิน ทำให้ payment **fail** (F5 test) | เด้งกลับ portal; รอบยัง **awaiting_payment**; ใบยัง unpaid |
| 2 | ตรวจ schedule | การเตือนกลับมาทำงานต่อ (จะได้ nudge ตามกำหนดถัดไป) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-27 — Member lapsed จ่ายเงิน → auto-reactivate (default)
**อ้างอิง:** US3-AS5, FR-005b · **บทบาท:** member (lapsed, ไม่ถูกบล็อค)

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | สมาชิก lapsed เปิด `/portal/renewal/<id>` | เห็นข้อความว่าสมาชิกภาพหมดอายุและสามารถต่ออายุเพื่อกู้สิทธิ์ได้ (behavioural paraphrase — ไม่ใช่ exact label) + flow ทำงานได้ |
| 2 | จ่ายเงินสำเร็จ | รอบเปลี่ยนจาก lapsed → **completed**; สิทธิ์คืนทันที (auto-reactivate) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-28 — Renewal token หมดอายุ / ใช้ซ้ำ ถูกปฏิเสธ (ไม่รั่ว oracle)
**อ้างอิง:** US3-AS7, FR-026, FR-027 · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | คลิกลิงก์ที่ token หมดอายุ (>30 วัน) | หน้า generic error "Your renewal link has expired. Please return to the portal and try again." |
| 2 | คลิกลิงก์ token ที่ถูกใช้ไปแล้ว (replay) | error เดียวกันเป๊ะ — **ไม่บอก** ว่า token เคย valid หรือไม่ |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-29 — Cross-member probe ถูกบล็อก
**อ้างอิง:** FR-020, FR-052a · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | สมาชิก A เปิด `/portal/renewal/<member_id ของ B>` | ได้ **404** + audit `renewal_cross_member_probe` (เข้าข้อมูลคนอื่นไม่ได้) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-30 — Pending review: Approve reactivation
**อ้างอิง:** FR-005b, FR-058 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิด `/admin/renewals` → แท็บ **"Pending review"** | เห็นรอบที่ `pending_admin_reactivation` (Member · Pending since · Expiry) |
| 2 | กด **"Review"** → ไปหน้า cycle detail (กล่อง "Awaiting your decision") | เห็นปุ่ม "Approve reactivation" / "Reject & refund" (admin เท่านั้น) |
| 3 | กด **"Approve reactivation"** → "Approve" | toast "Reactivation approved — the membership is now active."; รอบเป็น completed; คืนสิทธิ์ |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-31 — Pending review: Reject & refund (ต้องมีเหตุผล, ย้อนไม่ได้)
**อ้างอิง:** FR-005b, FR-005d · **บทบาท:** admin · **เงื่อนไข:** F5 เปิด

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | บน cycle detail (pending) กด **"Reject & refund"** → **ไม่ใส่เหตุผล** | ถูกบล็อก "Please enter a reason (1–500 characters)." |
| 2 | ใส่เหตุผล → กด **"Reject & refund"** | toast "Reactivation rejected and the payment was refunded."; รอบ cancelled + refund + credit note ออกอัตโนมัติ |
| 3 | ตรวจข้อความเตือน | มี "This action cannot be undone." |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-32 — Pending review เป็น admin-only (manager เห็นแต่กดไม่ได้)
**อ้างอิง:** FR-052a · **บทบาท:** manager

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | manager เปิด cycle detail ของรอบ pending | เห็นหน้าอ่านอย่างเดียว **ไม่มีปุ่ม** Approve/Reject |
| 2 | (ขั้นสูง) ยิง POST approve/reject ตรง | ได้ 403 + audit `f8_role_violation_blocked` |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-33 — Reminder schedules: แก้ + บันทึก (admin)
**อ้างอิง:** FR-008, FR-009 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิด Settings → Renewals → **Reminder schedules** | แท็บ 5 tier (Thai alumni…Partnership) |
| 2 | เลือก tier → **"Add step"** กำหนด Offset days + Delivery channel (Email/Task) | step ถูกเพิ่มในรายการ |
| 3 | กด **"Save schedule"** | toast "Schedule for <tier> saved (+x -y =z)"; บันทึก audit |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-34 — Reminder schedules: manager อ่านอย่างเดียว
**อ้างอิง:** FR-052a · **บทบาท:** manager

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | manager เปิดหน้า Reminder schedules | เห็นข้อความ "You have read-only access to renewal schedules. Ask an admin to make changes." |
| 2 | มองหาปุ่ม Save/Add/Remove | **กดไม่ได้** (อ่านอย่างเดียว) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-35 — Kill-switch ปิด F8 ทั้งหมด
**อ้างอิง:** FR-052 · **บทบาท:** admin · **เงื่อนไข:** ตั้ง `FEATURE_F8_RENEWALS=false`

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิด `/admin/renewals` | ขึ้น "The renewals workflow is not yet enabled for this chamber." |
| 2 | เปิด `/admin/renewals/<cycleId>`, `/tasks`, `/tier-upgrades` | ได้ **404** ทุกหน้า |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-36 — Granular kill-switch: ปิดเฉพาะ at-risk
**อ้างอิง:** FR-052b · **บทบาท:** admin · **เงื่อนไข:** ตั้ง `FEATURE_F8_AT_RISK_DISABLED=true`

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิด `/admin/renewals` | วิดเจ็ต at-risk ขึ้น "At-risk detection is temporarily unavailable." |
| 2 | ตรวจส่วนอื่น (pipeline, send reminder, tier-upgrades, tasks) | **ยังทำงานปกติ** |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-REN-37 — Pipeline render เร็วตามเป้า (perf)
**อ้างอิง:** US1-AS5, SC-003, FR-046 · **บทบาท:** admin · **เงื่อนไข:** preview + tenant ใหญ่ (~5,000 active)

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | โหลด `/admin/renewals` + สลับแท็บ/กรอง บน preview | p95 render < **500ms** (วัดจริง อย่าเดา; SC-003 มี evidence test) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ (ค่า p95 ที่วัดได้):** ____________________

---

## TC-REN-38 — i18n: เปลี่ยนภาษา EN/TH/SV ไม่พัง
**อ้างอิง:** FR-051, FR-050 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | สลับภาษาแอปเป็น TH แล้ว SV บนทุกหน้า F8 (pipeline, cycle detail, tasks, tier-upgrades, schedules) | ทุกป้ายแปลครบ **ไม่มี MISSING_MESSAGE / คีย์ดิบ** |
| 2 | ตรวจวันที่บน th-TH | แสดง พ.ศ. คู่ ค.ศ. (เก็บเป็น ค.ศ. เสมอ) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## สรุปผล + การลงนามรับรอง (ชุด F8 Renewals)

| รายการ | ค่า |
|---|---|
| จำนวน TC ทั้งหมด | 38 |
| ผ่าน | ______ |
| ไม่ผ่าน | ______ (ระบุเลข TC: __________) |
| รันบน (preview URL) | __________________________ |
| วันที่ทดสอบ | __________ |

| บทบาท | ชื่อ | ลายเซ็น | วันที่ |
|---|---|---|---|
| ผู้รับรอง UAT (SweCham) | | | |
| ผู้ดูแลระบบ | | | |

> ปัญหาที่พบให้บันทึกใน `docs/Bug/` หรือ issue และอ้างเลข TC ที่ไม่ผ่าน
