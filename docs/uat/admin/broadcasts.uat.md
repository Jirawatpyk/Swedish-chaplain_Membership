# UAT: ส่งอีเมลกลุ่ม / E-Blast — ตรวจ/อนุมัติ/ปฏิเสธ/ตั้งเวลา/halt (F7)

> **คู่มือ flow นี้:** [../../user-guide/admin/broadcasts.md](../../user-guide/admin/broadcasts.md)
> **ที่มา:** `specs/010-email-broadcast/spec.md` (US1/US2/US3/US4/US5/US6) + Success Criteria
> **รันบน:** preview deploy (ไม่ใช่ production) · บัญชี: admin, manager, member

## ก่อนเริ่ม (Preconditions รวม)
- [ ] `FEATURE_F7_BROADCASTS=true` (ระบบ F7 เปิด)
- [ ] มีบริษัทสมาชิกทดสอบที่อยู่ในแพ็กเกจมีโควต้า (`eblast_per_year > 0`) และมี **primary contact email** ครบ ≥ 1 ราย
- [ ] มีสมาชิกอีก 1 รายในแพ็กเกจที่ **ไม่มีโควต้า** (`eblast_per_year = 0`) สำหรับเคสปฏิเสธ
- [ ] มีบัญชี **admin**, **manager**, **member** ใช้งานได้ (ดู `.env.local` E2E_* creds)
- [ ] Resend Broadcasts ฝั่งระบบตั้งค่าครบ (api key / webhook secret / from email / unsubscribe secret) — ใช้ Resend **test mode** บน preview
- [ ] (เคส template/allowlist) เปิด sub-flag F7.1a US7 + US2 ถ้าจะทดสอบ TC-BC-23/24 — ถ้าปิดให้ทำเครื่องหมาย N/A
- [ ] กล่องอีเมลทดสอบ ≥ 1 ใบ (สำหรับ unsubscribe + delivery summary)

**วิธีกรอก:** แต่ละ TC ทำเครื่องหมาย ✅ ผ่าน / ❌ ไม่ผ่าน ในช่อง "ผล" + ใส่หลักฐาน (เลข broadcast id / สถานะ / ภาพหน้าจอ) ในช่อง "หมายเหตุ"

---

## TC-BC-01 — สมาชิกเขียน + submit E-Blast เข้าคิว (โควต้า reserve)
**อ้างอิง:** US1-AS1 · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ล็อกอิน member (แพ็กเกจมีโควต้า) → ไป `/portal/benefits?tab=broadcasts` | เห็นแถบโควต้า + ปุ่มเริ่มเขียน E-Blast |
| 2 | เขียน Subject (≤200 ตัว) + Body (≥1 ตัว HTML ที่ปลอดภัย) + เลือก Audience **All members** | ตัวแก้ไข rich text ใช้งานได้, preview แสดงผล, จำนวนผู้รับโดยประมาณขึ้น |
| 3 | กด Submit for review | สถานะ **Submitted**, โควต้าแสดง "5 of 6 remaining + 1 reserved" (หรือเทียบเท่า), หน้ายืนยันแจ้ง SLA ~48 ชม. |
| 4 | (ฝั่ง admin) เปิด `/admin/broadcasts` | เห็นรายการใหม่ในคิว สถานะ **Awaiting review** |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ (broadcast id):** ____________________

---

## TC-BC-02 — โควต้าหมด → ปุ่ม Submit ถูกปิด + API คืน 409
**อ้างอิง:** US1-AS2, FR-008 · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ใช้ member ที่ใช้โควต้าครบปีแล้ว เปิดหน้าเขียน | ปุ่ม Submit **disabled** + ข้อความ "All E-Blast quota for {year} has been used." (tooltip "Your {year} E-Blast quota is exhausted. Renews January 1 of next year.") |
| 2 | ลองยิง submit ตรงผ่าน API | คืน **409 `quota_exhausted`** + เขียน audit `broadcast_quota_blocked` |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-BC-03 — กลุ่มผู้รับว่าง (zero recipients) ถูกปฏิเสธ
**อ้างอิง:** US1-AS4 · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | สร้าง custom list ที่ทุกอีเมลถูก unsubscribe แล้ว (หรือ tier ว่าง) → Submit | ถูกปฏิเสธทั้ง client + server "No eligible recipients matched." |
| 2 | ตรวจว่าไม่มี row + ไม่จองโควต้า | ไม่มี broadcast row, ไม่ reserve, เขียน audit `broadcast_empty_segment_blocked` |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-BC-04 — เนื้อหา HTML อันตรายถูก sanitise + ปฏิเสธ
**อ้างอิง:** US1-AS7, FR-002a · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | วาง body ที่มี `<script>alert(1)</script>` + `<a href="javascript:void(0)">` แล้ว Submit | คืน **422 `broadcast_body_unsafe_html`** ระบุ construct ที่ผิด, ไม่มี row, ไม่ reserve |
| 2 | ตรวจ audit | เขียน `broadcast_body_unsafe_html` พร้อม **จำนวน** construct (ไม่เก็บเนื้อหา) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-BC-05 — สมาชิกไม่มีโควต้า (eblast_per_year=0) ถูกซ่อนหน้าเขียน
**อ้างอิง:** US1-AS6, FR-009 · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ล็อกอิน member แพ็กเกจไม่มีโควต้า → เปิด tab broadcasts | **ไม่เห็นหน้าเขียน** — แสดง explainer + CTA ให้อัปเกรดแพ็กเกจ |
| 2 | ลองยิง submit ตรงผ่าน API | คืน **403 `broadcast_not_in_plan`** + audit ชื่อเดียวกัน |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-BC-06 — admin ตรวจคิว + อนุมัติส่งทันที (Approve & send now)
**อ้างอิง:** US2-AS1, US2-AS2 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิด `/admin/broadcasts` | default กรอง **Awaiting review** เรียงเก่าสุดก่อน; แถบบนแสดง "Target review SLA: 48 hours" |
| 2 | คลิกแถว → หน้า Broadcast review | เห็น Subject / Message (render จริง) / Audience / Estimated recipients / Submitted by / timeline |
| 3 | กด **Approve** → เลือก **Approve & send now** → **Approve** | สถานะ **Submitted → Approved → Sending**; toast "Broadcast approved." |
| 4 | ตรวจอีเมลแจ้งสมาชิก + audit | สมาชิกได้อีเมลอนุมัติ ~2 นาที; audit มี `broadcast_approved` + `broadcast_send_started` |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-BC-07 — อนุมัติแบบตั้งเวลา (Approve & schedule, Asia/Bangkok)
**อ้างอิง:** US2-AS4, US6-AS1, FR-011 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิดแถว Submitted → Approve → เลือก **Approve & schedule** | ช่อง **Send at** ปรากฏ, help text ระบุ "≥5 นาที, Asia/Bangkok" |
| 2 | เลือกเวลา +1 ชม. | preview "Will be sent on:" แสดงเวลา **Bangkok** ตรงกับที่กรอก (ไม่เพี้ยนตาม TZ เบราว์เซอร์) |
| 3 | กด Approve | สถานะ **Approved** + ตั้ง `scheduled_for` (ยังไม่เรียก Resend) |
| 4 | รอ/trigger cron หลังเลยเวลา | Resend ถูกเรียก **ครั้งเดียว**, สถานะ **Approved → Sending**, audit `broadcast_send_started` มี delay |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-BC-08 — ปฏิเสธ (Reject) ต้องมีเหตุผล + คืนโควต้า
**อ้างอิง:** US2-AS3, FR-012 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิดแถว Submitted → กด **Reject** | กล่อง "Reject this broadcast?"; ปุ่มยืนยัน disabled จนกว่าจะกรอกเหตุผล |
| 2 | กรอก reason "Off-tone for chamber" (ตัวนับ n/2000) → **Reject** | สถานะ **Rejected**; toast "Broadcast rejected. The member has been notified." |
| 3 | ตรวจโควต้าสมาชิก + อีเมล + audit | โควต้ากลับเป็นก่อน submit; สมาชิกได้อีเมลพร้อมเหตุผลคำต่อคำ; audit `broadcast_rejected` (เก็บ hash ของเหตุผล) |
| 4 | ลองส่ง reject ด้วยเหตุผลว่าง/เว้นวรรคล้วน | ถูกปฏิเสธ — เหตุผลต้อง ≥1 ตัวอักษรที่ไม่ใช่ช่องว่าง |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-BC-09 — manager เป็นสิทธิ์อ่านอย่างเดียว (ไม่มีปุ่มลงมือ)
**อ้างอิง:** US2-AS5, FR-014 · **บทบาท:** manager

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ล็อกอิน manager → เปิด `/admin/broadcasts` | เห็นคิว + แถบ **"Read-only mode"** (manager); **ไม่มี** ปุ่ม Approve/Reject/Bulk |
| 2 | เปิดหน้า Broadcast review | เห็นข้อมูลครบ แต่ **ไม่มีปุ่มลงมือใดๆ** |
| 3 | (มี halt) ดูแถบ halt | เห็นข้อความ "Manager role — read-only" แทนปุ่ม clear |
| 4 | ยิง API approve/reject ตรง | คืน **403 `not_authorised`** + audit |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-BC-10 — กันการอนุมัติซ้อน (concurrent action) คืน 409
**อ้างอิง:** US2-AS6 · **บทบาท:** admin (2 หน้าต่าง / 2 admin)

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิด broadcast เดียวกัน 2 แท็บ → แท็บ A กด Approve สำเร็จ | แท็บ A สำเร็จปกติ |
| 2 | แท็บ B กด Approve/Reject แถวเดิม | คืน **409**; toast "This broadcast was already actioned by another administrator." + refresh; **ไม่มี double-send**; audit `broadcast_concurrent_action_blocked` |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-BC-11 — แก้เนื้อหาหลัง submit ไม่ได้ (immutable)
**อ้างอิง:** US/FR-004, Q3, Edge case "Edit attempt" · **บทบาท:** admin / member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | หน้า Broadcast review ของรายการ Submitted | **ไม่มี** ปุ่มแก้ subject/body/audience — admin แก้เนื้อหาแทนไม่ได้ |
| 2 | ลอง PATCH row ที่ status ≠ draft ผ่าน API | คืน **409 `broadcast_immutable_after_submit`** + audit ชื่อเดียวกัน; ไม่มี field ถูกแก้ |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-BC-12 — ยกเลิกได้ถึง Approved แต่ Sending ยกเลิกไม่ได้
**อ้างอิง:** US6-AS4, US6-AS6, FR-004a, Q10 · **บทบาท:** admin / member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | รายการ **Approved (ตั้งเวลา)** → ยกเลิก **ผ่าน API โดยตรง** (`POST /api/broadcasts/[id]/cancel` หรือ `POST /api/admin/broadcasts/[id]/cancel`) — *N/A สำหรับส่วน UI: ยังไม่มีปุ่มยกเลิกในหน้าจอใน MVP, ตรวจผ่าน API เท่านั้น* | สถานะ **Cancelled**, คืนโควต้า, cron ข้ามแถวนี้, audit `broadcast_cancelled` (admin-cancel ต้องมีเหตุผล) |
| 2 | รายการ **Sending** (Resend รับแล้ว) → ลองยกเลิก | คืน **409 `broadcast_cancel_too_late`** + audit ชื่อเดียวกัน; สถานะไม่เปลี่ยน |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-BC-13 — โควต้า consume ตอน Sent (ไม่ใช่ตอน submit/approve)
**อ้างอิง:** US5-AS3, FR-003, FR-007, FR-028 · **บทบาท:** admin + webhook

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | broadcast **Sending** → จำลอง webhook Resend (delivered/bounced/complained) ครบ | สร้าง `broadcast_deliveries` ตามอีเวนต์, นับ aggregate ถูก, สถานะ **Sending → Sent** |
| 2 | ตรวจโควต้า + audit ตอน Sent | โควต้า **consume +1** (ตามปีปฏิทินของ timestamp Sent); audit `broadcast_sent` + `broadcast_quota_consumed`; สมาชิกได้อีเมลสรุป |
| 3 | ส่ง webhook payload เดิมซ้ำ | **idempotent** — ไม่มี row ซ้ำ, ไม่ consume ซ้ำ, ไม่มี audit ซ้ำ |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-BC-14 — webhook ลายเซ็นผิด ถูกปฏิเสธ 401
**อ้างอิง:** US5-AS2, FR-024 · **บทบาท:** system/webhook

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ยิง `/api/webhooks/resend-broadcasts` ด้วย HMAC ที่ไม่ตรง secret | คืน **401**, ไม่อ่าน/ไม่เก็บ payload, audit `broadcast_webhook_signature_rejected` เท่านั้น |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-BC-15 — ผู้รับ unsubscribe (public, no-login) + idempotent
**อ้างอิง:** US4-AS1, US4-AS3, FR-029, FR-030 · **บทบาท:** recipient (ไม่ล็อกอิน)

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | จากอีเมล broadcast คลิกลิงก์ unsubscribe → `/unsubscribe/{token}` | หน้า public สองภาษา ยืนยันยกเลิกรับของหอการค้านั้น; สร้าง row ใน `marketing_unsubscribes`; audit `broadcast_unsubscribed` (email hash) |
| 2 | reload หน้าเดิม / คลิกซ้ำ | ข้อความ idempotent "Already unsubscribed / Your email is already on our suppression list. No further action needed."; ไม่มี row/audit ซ้ำ |
| 3 | คลิก token ที่ปลอม/หมดอายุ | หน้า fallback สองภาษาแนะนำติดต่อ support; **ไม่สร้าง** suppression; audit `broadcast_unsubscribe_token_invalid` |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-BC-16 — suppression ถูกหักตอนส่ง + ไม่กระทบ transactional
**อ้างอิง:** US4-AS4, US4-AS5, SC-004, FR-017 · **บทบาท:** admin + member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | มีผู้รับ 1 รายอยู่ใน suppression list → ส่ง broadcast ใหม่ไปกลุ่มที่รวมเขา | อีเมลนั้น **ไม่ถูกส่ง** (กรองก่อนถึง Resend); สรุปแสดง "Suppressed: 1" โดยไม่ระบุชื่อ; audit `broadcast_suppression_applied` |
| 2 | ผู้รับที่ unsubscribe เป็นสมาชิกด้วย → ทดสอบอีเมล transactional (เช่น รีเซ็ตรหัส/ใบเสร็จ) | **ยังได้รับ** transactional ปกติ (suppression คุมเฉพาะ marketing) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-BC-17 — เพดานผู้รับ 5,000 ราย/ฉบับ ถูกปฏิเสธ
**อ้างอิง:** FR-016a, Q7, Edge case "Recipient list cap" · **บทบาท:** member (หรือ fixture ผู้รับจำนวนมาก)

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | submit broadcast ที่กลุ่ม resolve + หัก suppression แล้ว >5,000 | ถูกปฏิเสธที่ submit boundary **`broadcast_audience_too_large`** "Audience exceeds the 5,000 recipient limit."; audit เก็บจำนวนที่เกิน (ไม่เก็บรายชื่อ) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-BC-18 — auto-halt เมื่อ complaint rate เกิน 5% + admin เคลียร์
**อ้างอิง:** US5-AS6, SC-005(b), Q14, FR-027 · **บทบาท:** system + admin + manager

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | จำลอง broadcast ผู้รับ ≥20 ราย ที่ complaint rate >5% | ระบบตั้ง `broadcasts_halted_until_admin_review=true`; audit `broadcast_complaint_rate_per_broadcast_breach`; alert on-call |
| 2 | สมาชิกที่ถูก halt ลอง submit ใหม่ | ถูกบล็อก **`broadcast_member_halted_pending_review`** |
| 3 | admin เปิด `/admin/broadcasts` | แถบแดงบนสุด "{n} member(s) are halted" + ปุ่ม **Review + clear halt** |
| 4 | กด clear → **พิมพ์ชื่อบริษัท** ให้ตรง → **Clear halt** | toast "Broadcast halt cleared"; audit `broadcast_member_dispatch_resumed`; สมาชิก submit ได้อีก |
| 5 | (manager) ดูแถบ halt | เห็น "Manager role — read-only" แทนปุ่ม (เคลียร์ไม่ได้) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-BC-19 — สมาชิกดูโควต้า + ประวัติ broadcast ของตัวเอง
**อ้างอิง:** US3-AS1, US3-AS4 · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | member มี 2 sent + 1 submitted → เปิด tab broadcasts | โควต้าแสดง "2 sent · 1 reserved · 3 remaining of 6 · resets 1 January 20xx" (ตาม locale) |
| 2 | ดูตารางประวัติ | 3 แถว สถานะถูกต้อง เรียงวันที่ล่าสุดก่อน |
| 3 | member ที่ยังไม่เคยส่งเลย | empty-state + CTA "Compose your first E-Blast" (ไม่มีตาราง) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-BC-20 — กันสมาชิกแอบดู broadcast ของคนอื่น (404 ไม่ใช่ 403)
**อ้างอิง:** US3-AS5 · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | member ลองเปิด URL broadcast ของสมาชิกอื่น (เดา id) | คืน **404** (ไม่ใช่ 403 เพื่อไม่ leak การมีอยู่); audit `broadcast_cross_member_probe` |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-BC-21 — แบนเนอร์รับทราบเงื่อนไขการตลาด (GDPR Art. 7)
**อ้างอิง:** US3-AS6, US3-AS7, US3-AS8, Q15 · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | member (มีโควต้า/active) ที่ `broadcasts_acknowledged_at` ว่าง → ล็อกอิน portal | แบนเนอร์สองภาษาแจ้งสิทธิ์ broadcast + ปุ่ม **I acknowledge** + ลิงก์ **Remind me later** |
| 2 | กด **I acknowledge** | บันทึก timestamp; audit `member_acknowledged_broadcasts_terms`; แบนเนอร์หายถาวร (per tenant) |
| 3 | (member อื่น) กด **Remind me later** | ไม่บันทึก audit/คอลัมน์; แบนเนอร์โผล่อีกครั้งเมื่อ sign-in รอบหน้า |
| 4 | admin/manager ล็อกอิน | **ไม่เห็น** แบนเนอร์ (เฉพาะ role member) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-BC-22 — Bulk approve หลายรายการพร้อมกัน
**อ้างอิง:** US2 (FR-010/FR-011 batch UX) · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เลือกหลายแถว Submitted ด้วย checkbox | แถบ "{n} selected" + ปุ่ม **Approve & send selected** |
| 2 | กด Approve & send selected (สำเร็จทั้งหมด) | toast "All selected broadcasts approved.", ทุกแถวขยับเป็น Approved/Sending |
| 3 | ทำซ้ำโดยมี 1 แถวถูก admin อื่นกดไปก่อน | toast "{ok} approved, {fail} failed." — แถวพลาดต้องอนุมัติทีละรายการ |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-BC-23 — จัดการ Template (F7.1a US7 — ข้าม/N/A ถ้า flag ปิด)
**อ้างอิง:** F7.1a US7 (template library) · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | admin กดปุ่ม **Templates** ในหน้า Broadcasts | เข้า `/admin/broadcasts/templates`; ฟิลเตอร์ All/Starter only/Admin-authored; แถว Starter มีป้าย |
| 2 | New template → กรอก Name/Subject/Body/Locale → Save template | toast "Template saved.", เห็นในตาราง |
| 3 | Edit Starter template | แบนเนอร์เตือน "This is a starter template"; แก้แล้วสร้างเวอร์ชัน tenant |
| 4 | (manager) เปิด `/admin/broadcasts/templates` ตรง | ได้ **404** (template admin-only) |
| 5 | (flag US7 ปิด) เปิดหน้าเดิม | ได้ **404** + ปุ่ม Templates ไม่แสดงในหน้า Broadcasts → ทำเครื่องหมาย **N/A** ทั้ง TC นี้ |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน ☐ N/A — **หมายเหตุ:** ____________________

---

## TC-BC-24 — Broadcast settings: image allowlist (F7.1a US2 — ข้าม/N/A ถ้า flag ปิด)
**อ้างอิง:** F7.1a US2 (image embedding allowlist) · **บทบาท:** admin / manager

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | admin เปิด **Broadcast settings** (`/admin/settings/broadcasts`) | การ์ด "Image source allowlist" + รายการ default (locked) |
| 2 | กรอก hostname (`cdn.example.com`) → Add hostname | toast "Hostname added.", แถวใหม่ปรากฏ |
| 3 | ลอง Remove แถว **Default (locked)** | ลบไม่ได้ (error "Default entries cannot be removed.") |
| 4 | (manager หรือ flag US2 ปิด) เปิดหน้าเดิม | ได้ **404** → ทำเครื่องหมาย **N/A** ถ้า flag ปิด |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน ☐ N/A — **หมายเหตุ:** ____________________

---

## TC-BC-25 — Cross-tenant isolation (admin/member เห็นเฉพาะ tenant ตน)
**อ้างอิง:** FR-036, FR-037, SC-009 · **บทบาท:** admin/member (multi-tenant — รันได้เมื่อมี fixture 2 tenant)

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | admin tenant A ลองเปิด broadcast id ของ tenant B (เดา) | คืน **404** (ไม่ leak); audit `broadcast_cross_tenant_probe` |
| 2 | unsubscribe ใน tenant A | **ไม่** ทำให้ผู้รับคนเดียวกันถูก unsubscribe ใน tenant B |

> ⚠️ SweCham เป็น single-tenant — TC นี้ครอบคลุมโดย cross-tenant integration test (Review-Gate blocker) เป็นหลัก; บน preview ที่ไม่มี fixture 2 tenant ให้ทำเครื่องหมาย **N/A** + อ้างผล integration test แทน

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน ☐ N/A — **หมายเหตุ:** ____________________

---

## สรุปผล + การลงนามรับรอง (ชุด F7 Broadcasts / E-Blast)

| รายการ | ค่า |
|---|---|
| จำนวน TC ทั้งหมด | 25 |
| ผ่าน | ______ |
| ไม่ผ่าน | ______ (ระบุเลข TC: __________) |
| N/A (flag ปิด / single-tenant) | ______ (ระบุเลข TC: __________) |
| รันบน (preview URL) | __________________________ |
| วันที่ทดสอบ | __________ |

| บทบาท | ชื่อ | ลายเซ็น | วันที่ |
|---|---|---|---|
| ผู้รับรอง UAT (SweCham) | | | |
| ผู้ดูแลระบบ | | | |

> ปัญหาที่พบให้บันทึกใน `docs/Bug/` หรือ issue และอ้างเลข TC ที่ไม่ผ่าน
> หมายเหตุพิเศษ: gate `@a11y` / `@i18n` / perf เป็นการวัดบน **preview deploy** เท่านั้น — local dev fail ถือเป็น noise ไม่ใช่ regression
