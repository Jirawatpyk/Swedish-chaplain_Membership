# UAT: คู่มือสมาชิก — เริ่มต้นใช้งาน Member Portal (MEMBER)

> **คู่มือ flow นี้:** [../../user-guide/member/quick-start.md](../../user-guide/member/quick-start.md)
> **ที่มา:** `specs/005-members-contacts/spec.md` (US5 member self-service · US6 timeline) + `specs/009-online-payment/spec.md` (US1 card · US2 PromptPay · US5 failure · US6 receipt) + `specs/015-admin-dashboard/spec.md` (US4 benefit usage · US6 GDPR export) + Success Criteria
> **รันบน:** preview deploy (ไม่ใช่ production) · บัญชี: member (Primary + Secondary), admin, manager

## ก่อนเริ่ม (Preconditions รวม)
- [ ] มีบริษัทสมาชิกทดสอบ ≥ 1 ราย ผูกกับ user สมาชิก (มี **Primary** contact + อย่างน้อย 1 **Secondary** contact)
- [ ] มีอีเมลเชิญที่ยัง **ไม่หมดอายุ + ไม่เคยถูกใช้** (สำหรับ TC-MEM-01) และอีเมลเชิญที่ **หมดอายุ/ถูกใช้แล้ว** (สำหรับ negative case)
- [ ] บริษัททดสอบมีใบแจ้งหนี้สถานะ **Issued** ≥ 1 ใบ และ **Paid** ≥ 1 ใบ (มีใบเสร็จ)
- [ ] เปิด `FEATURE_F5_ONLINE_PAYMENT` + `tenant_payment_settings.online_payment_enabled = true` + เปิด method ทั้ง card และ promptpay (สำหรับ TC-MEM-08/09) — และมีใบที่ online payment **ปิด** สำหรับ negative case
- [ ] เปิด `FEATURE_F9_DASHBOARD` (+ `EXPORT_DOWNLOAD_TOKEN_SECRET`) สำหรับ TC-MEM-14/15 (data export) — มีใบที่ปิด F9 เพื่อยืนยันการ์ดไม่แสดง
- [ ] เปิด `FEATURE_F7_BROADCASTS` + แพ็กเกจมีสิทธิ์ E-Blast สำหรับ TC-MEM-16
- [ ] บัตรทดสอบ Stripe พร้อม (เช่น `4242…` success, `4000…0002` decline) + อุปกรณ์สแกน PromptPay test
- [ ] บัญชี **manager** และ user ที่ผูกกับ **บริษัทอื่น** สำหรับ negative/permission cases

**วิธีกรอก:** แต่ละ TC ทำเครื่องหมาย ✅ ผ่าน / ❌ ไม่ผ่าน ในช่อง "ผล" + ใส่หลักฐาน (เลขเอกสาร/ภาพหน้าจอ/เลขอ้างอิงการจ่าย) ในช่อง "หมายเหตุ"

---

## TC-MEM-01 — เปิดใช้งานบัญชีจากอีเมลเชิญ
**อ้างอิง:** 005 US5-AS4, US1-AS5 (invite flow) · **บทบาท:** member (ผู้ถูกเชิญ)

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | กดลิงก์ในอีเมลเชิญ → หน้า `/invite/[token]` | หัวข้อ **"Finish setting up your account"**, ช่อง **Email** เติมมาให้ (แก้ไม่ได้) |
| 2 | กรอก **Your name**, ตั้ง **Choose a password** (≥12 ตัว, ไม่อยู่ใน breach) | password-strength meter ผ่าน |
| 3 | กด **"Activate account"** | สร้างบัญชี + เข้าสู่ระบบ → เด้งไป `/portal` Dashboard |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MEM-02 — ลิงก์เชิญหมดอายุ / ถูกใช้แล้ว ถูกปฏิเสธ
**อ้างอิง:** 005 US5-AS4 (invite lifecycle) · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิดลิงก์เชิญที่ **หมดอายุ** | ข้อความ **"This invitation has expired…"** + ปุ่ม **"Contact an administrator to request a new invitation"** |
| 2 | เปิดลิงก์เชิญที่ **ถูกใช้ไปแล้ว** | ข้อความ **"This invitation has already been used."** |
| 3 | ลองตั้งรหัสซ้ำจากลิงก์เดิมที่ activate ไปแล้ว | ทำไม่ได้ (ลิงก์ใช้ครั้งเดียว) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MEM-03 — Dashboard: สถานะ + เลขสมาชิก + การ์ดสรุป
**อ้างอิง:** 005 US5-AS1 · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เข้า `/portal` | หัวข้อ **"Hi {ชื่อ}"**, badge **เลขสมาชิก** (`SCCM-NNNN`) + ป้ายสถานะ **Active/Inactive/Archived** |
| 2 | ดูการ์ดสรุป 3 ใบ | **Membership** + **Outstanding balance** (+จำนวนใบค้าง / **"All paid"**) + **Benefits** แสดงค่าจริง ไม่ใช่ศูนย์ลอยๆ |
| 3 | ดูบล็อกล่าง | **Recent invoices** (≤3 ใบ) + **Benefit usage · {ปี}** + **Recent activity** |
| 4 | (ถ้าบัญชียังไม่ผูกบริษัท) เข้า `/portal` | การ์ดต้อนรับ **"Welcome to the … member portal"** + ปุ่ม **"Explore your benefits"** (ไม่ใช่ศูนย์+ลิสต์ว่าง) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MEM-04 — เห็นเฉพาะบริษัทตัวเอง (cross-member ป้องกัน)
**อ้างอิง:** 005 US5-AS1, SC-005 (tenant isolation) · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | สมาชิกบริษัท A เปิด `/portal/invoices` | เห็นเฉพาะใบของบริษัท A |
| 2 | คัดลอก invoiceId ของ **บริษัท B** มาเปิด `/portal/invoices/{idของB}` | ได้ **404 / not found** (ไม่รั่วว่ามีใบอยู่จริง) + บันทึก probe audit |
| 3 | ลองเข้า `/admin/**` ด้วยบัญชี member | ถูกปฏิเสธ (not-authorised / redirect) — เข้าหน้า admin ไม่ได้ |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MEM-05 — รายการใบแจ้งหนี้ + filter + ซ่อน Draft
**อ้างอิง:** 005 US5 (self-service reads), F4 US3-AS1/AS3 · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิด `/portal/invoices` (บริษัทมี 3 ใบ) | เห็น 3 แถว: Number / Status / Issued / Due / Total / Actions |
| 2 | กรองสถานะ **Paid** แล้ว **Overdue** | ตารางกรองถูกต้อง (Overdue = Issued + เลยกำหนด) |
| 3 | มองหาใบ **Draft** | **ไม่มีใบ Draft** แสดงเลย (สมาชิกไม่เห็นร่าง) |
| 4 | บริษัทที่ไม่มีใบเลย | ขึ้น empty state **"No invoices yet…"** (ไม่ใช่ error) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MEM-06 — เปิดรายละเอียดใบ + ดาวน์โหลด PDF
**อ้างอิง:** F4 US3-AS1, US1-AS3 (byte-identical PDF) · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | กดเลขเอกสาร → หน้ารายละเอียด (อ่านอย่างเดียว) | เห็น line items (TH+EN), Subtotal, VAT, Total, Issued/Due/Paid, เลขใบเสร็จ (ถ้าจ่ายแล้ว) |
| 2 | ใบ Issued: กด **"Invoice"** | ได้ PDF ใบกำกับภาษี |
| 3 | ใบ Paid (แยกเลข): กด **"Receipt"** | ได้ PDF ใบเสร็จ; ใบ Paid (รวมเลข) ปุ่มเป็น **"Tax invoice / Receipt"** |
| 4 | โหลด PDF ใบเดิมซ้ำ 2 ครั้ง | เนื้อหาเหมือนกันทุกประการ (archived source-of-truth) |
| 5 | (ถ้าใบเสร็จยังจัดทำ) | ขึ้น **"Receipt preparing…"** — ไม่ค้างเป็น spinner ถาวร |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ (เลขที่โหลด):** ____________________

---

## TC-MEM-07 — ส่งสำเนาใบเข้าอีเมลซ้ำ (Email me a copy)
**อ้างอิง:** F4 US (resend self-service) · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ในแถว/หน้ารายละเอียด กด **"Email me a copy"** | toast **"Copy queued — check your inbox shortly."** + ได้อีเมลแนบ PDF |
| 2 | กดซ้ำเร็วๆ หลายครั้ง | ถูก rate-limit: **"You already asked for a copy recently…"** (กันสแปม) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MEM-08 — จ่ายใบออนไลน์ด้วยบัตร (card)
**อ้างอิง:** 009 US1-AS1, SC-003, SC-008 · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิดใบ Issued → กด **"Pay now"** | drawer **"Pay invoice"** เปิด แสดง Order summary + **Amount due** |
| 2 | เลือกแท็บ **Card** → กรอกบัตรทดสอบ success → จ่าย | ขึ้น **"Payment received"**, สถานะใบ → **Paid** ทันที |
| 3 | ตรวจอีเมล | ได้ใบเสร็จ (1 ฉบับ ไม่ใช่ 2) ภายใน ~1 นาที + บรรทัด "Paid online via card ending ****xxxx" |
| 4 | กด **"Download receipt"** บนหน้าสำเร็จ | ได้ PDF ใบเสร็จ |
| 5 | ตรวจ audit (admin) | ลำดับ `payment_initiated → payment_succeeded → invoice_paid` |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ (charge ref):** ____________________

---

## TC-MEM-09 — จ่ายใบออนไลน์ด้วย PromptPay QR
**อ้างอิง:** 009 US2-AS1, US2-AS2, SC-004 · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิดใบ Issued → **"Pay now"** → แท็บ **PromptPay** | แสดง **QR code** + amount + นับเวลาถอยหลัง + "scan with any Thai bank app" (TH นำ + EN) |
| 2 | สแกนจ่ายภายในเวลา | หน้าจอเด้งเป็น **"Payment received"** เอง (ไม่ต้อง refresh), สถานะ → **Paid**, ไม่มี card metadata |
| 3 | ปล่อย QR หมดอายุ แล้วกลับมา | ข้อความ **"QR code expired"** + ปุ่ม **"Refresh QR"** ออก QR ใหม่ได้ |
| 4 | มีคำเตือนใต้ QR | **"Only scan the QR code shown above; do NOT transfer manually…"** |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MEM-10 — บัตรถูกปฏิเสธ → ใบยังไม่ถูกแตะ
**อ้างอิง:** 009 US1-AS3, US5-AS1, SC-006 · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | จ่ายด้วยบัตร decline (`4000…0002`) | ข้อความสองภาษาตามรหัสปฏิเสธ (เช่น **"Your card was declined."**) — ไม่ใช่ generic |
| 2 | ตรวจสถานะใบ | ยังเป็น **Issued** (ไม่ถูก mark paid) |
| 3 | กด **"Try again"** / **"Use another method"** | ลองบัตรใหม่/วิธีอื่นได้โดยไม่ออกจากหน้า |
| 4 | ตรวจ audit | มี `payment_failed` พร้อมรหัสเหตุผล (ไม่มี PAN) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MEM-11 — ปิดแท็บกลางคัน ไม่เกิดการเรียกเก็บซ้ำ
**อ้างอิง:** 009 US1-AS4 · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เริ่มจ่าย (สร้าง payment intent) แล้วปิดแท็บ/ออกจากหน้า | ไม่มีการเรียกเก็บซ้ำ |
| 2 | กลับมาเปิดใบเดิมอีกครั้ง | เห็น pay surface เดิม (re-use intent); ถ้าจ่ายสำเร็จไปแล้วแสดง **Paid** |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MEM-12 — Online payment ปิด → แสดงการ์ดติดต่อ admin (ไม่มี Pay now)
**อ้างอิง:** 009 US (FR-016 render-gate), SC-013 · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิดใบ Issued ของ tenant ที่ `online_payment_enabled=false` | **ไม่มีปุ่ม "Pay now"**; ขึ้นการ์ด **"Online payment unavailable"** |
| 2 | กด **"Contact administrator"** | เปิด mail-to ขอวิธีโอนผ่านธนาคาร (subject อ้างเลขใบ) |
| 3 | ลองเปิด pay drawer ด้วย `?pay=1` ตรงๆ | ไม่เปิดฟอร์มจ่าย (gate ฝั่ง server) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MEM-13 — ใบที่ถูก Void หลังจ่าย → คืนเงินอัตโนมัติ + แถบแจ้ง
**อ้างอิง:** 009 US1-AS5 (auto-refund stale invoice) · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิดใบที่ admin **void** หลังสมาชิกจ่าย | แถบ **"Invoice voided"** + **"This invoice is no longer payable."** |
| 2 | ดูบล็อกคืนเงิน | **"Your payment has been refunded"** + ข้อความเงินคืนภายใน 5–10 วันทำการ + **"Refund reference: …"** |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MEM-14 — ดูโปรไฟล์ + แก้เฉพาะช่องที่อนุญาต (whitelist)
**อ้างอิง:** 005 US5-AS1, US5-AS2, FR-042 (forbidden fields hidden) · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิด `/portal/profile` | เห็นการ์ด Organisation / Membership / Contacts ของบริษัทตัวเอง |
| 2 | กด **"Edit Profile"** → `/portal/edit` | ฟอร์มมีเฉพาะ **First Name / Last Name / Phone / Preferred Language / Website / Description** |
| 3 | มองหา plan / tax ID / status / legal entity / email ในฟอร์ม | **ไม่แสดงเลย** (hidden, ไม่ใช่ disabled) |
| 4 | แก้ **Phone** → **"Save Changes"** | ขึ้น **"Profile updated successfully."**; ตรวจ audit มี `member_self_updated` {fields_changed:[phone]} |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MEM-15 — แก้ช่องต้องห้ามผ่าน crafted request ถูกปฏิเสธ
**อ้างอิง:** 005 US5-AS3 (forge plan/turnover/status → 403) · **บทบาท:** member (crafted)

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ยิง request แก้ `plan` / `turnover` / `status` (ปลอม payload) | server ปฏิเสธ **403** |
| 2 | ตรวจ audit | มี `member_self_update_forbidden` พร้อม payload (redact PII) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MEM-16 — เชิญเพื่อนร่วมงาน (เฉพาะ Primary contact)
**อ้างอิง:** 005 US5-AS4 · **บทบาท:** member (Primary) + member (Secondary)

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | Primary เปิด `/portal/profile` → การ์ด Contacts | เห็นปุ่ม **"Invite Colleague"** |
| 2 | กรอก First/Last/Email/Role/Preferred Language → **"Send Invitation"** | ขึ้น **"Invitation sent successfully."** เพื่อนได้อีเมลเชิญ |
| 3 | เพื่อน activate คำเชิญ | user ใหม่ผูกกับ **บริษัทเดียวกัน** + มี contact record ใหม่ |
| 4 | Secondary contact เปิดหน้า Profile / `/portal/contacts/invite` | **ไม่เห็นปุ่ม**; เข้า URL ตรงได้ข้อความ **"Only the primary contact can invite colleagues."** |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MEM-17 — เปลี่ยนรหัสผ่าน (Account hub)
**อ้างอิง:** F1 change-password (security-critical) · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | `/portal/account` → การ์ด Account → กรอก Current + New → **"Change password"** | ขึ้น **"Password updated. Other sessions have been signed out."** |
| 2 | ตรวจอุปกรณ์อื่นที่ล็อกอินอยู่ | ถูก sign out หมด (เครื่องปัจจุบันยังอยู่) |
| 3 | ใส่ Current password ผิด | **"Current password is incorrect."** |
| 4 | กด **"Forgot your password?"** | ไป `/forgot-password` ขอลิงก์รีเซ็ตได้ |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MEM-18 — เปลี่ยนภาษาแจ้งเตือน (Notification language)
**อ้างอิง:** portal preferred-locale · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | `/portal/account` → การ์ด **"Notification language"** เลือกภาษา → **"Save preference"** | ขึ้น **"Notification language updated."** |
| 2 | เลือก **"Use chamber default"** → save | บันทึกได้ (อีเมลตามค่า default หอการค้า) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MEM-19 — ขอ export ข้อมูลของฉัน (GDPR/PDPA self-service)
**อ้างอิง:** 015 US6-AS1, US6-AS2, US6-AS3, SC-008 · **บทบาท:** member (F9 ON)

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | `/portal/account` → การ์ด **"Data & privacy"** → **"Request my data export"** | ขึ้น **"Export requested"**; สถานะ **Preparing** ในตาราง |
| 2 | รอ job เสร็จ | สถานะ → **Ready to download** + ปุ่ม **"Download"** |
| 3 | กด **Download** | ได้ archive: profile, contacts, invoices(+PDF), events, broadcasts, activity-log ของ **ตัวเองเท่านั้น** + README |
| 4 | ตรวจ audit | บันทึก request + delivery |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MEM-20 — ลิงก์ดาวน์โหลด export หมดอายุ
**อ้างอิง:** 015 US6-AS3 (single-use, short-TTL link) · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ปล่อยลิงก์ดาวน์โหลดเกิน 1 ชั่วโมงหลังพร้อม | ดาวน์โหลดไม่ได้ / สถานะ **Expired**; มี hint ให้ขอ export ใหม่ |
| 2 | กดขอ export ใหม่ | สร้าง job ใหม่ได้ |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MEM-21 — export ของสมาชิกอื่นถูกปฏิเสธ
**อ้างอิง:** 015 US6-AS5, FR-032, SC-009 · **บทบาท:** member (crafted)

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | สมาชิกพยายามขอ export ของ memberId อื่น (crafted request) | ถูกปฏิเสธ — export ได้เฉพาะข้อมูลตัวเอง |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MEM-22 — Data & privacy / Directory ไม่แสดงเมื่อ F9 ปิด หรือบัญชีไม่ผูกบริษัท
**อ้างอิง:** 015 (F9 gate) + 005 (memberId-null guard) · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | F9 **ปิด** → เปิด `/portal/account` | **ไม่มีการ์ด "Data & privacy"** (และ `/portal/account/data-export` ได้ 404) |
| 2 | บัญชี **ไม่ผูกบริษัท** → เปิด `/portal/account` | ส่วน Renewal + Data & privacy ถูกซ่อน; ส่วน Account + Appearance ยังใช้ได้ |
| 3 | F9 **ปิด** → เปิด `/portal/profile` | ส่วน **Directory listing** ไม่แสดง |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MEM-23 — ดู Benefit usage (โควตา + under-use)
**อ้างอิง:** 015 US4-AS1, US4-AS2, US4-AS3, SC-006 · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิด `/portal/benefits` แท็บ **Benefits** | การ์ด **"Benefit usage · {ปี}"**; E-Blast แสดงเช่น **"2 of 6 used"** + last-used + ลิงก์ลงมือทำ |
| 2 | สมาชิกใช้ 33% ที่ 62% ของปี | มีคำเตือน under-use + ปุ่มพาไปใช้สิทธิ์ |
| 3 | สิทธิ์แบบไม่จำกัด/ไม่นับจำนวน | แสดงเป็น available/active ไม่ใช่ตัวเลขโควตา |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MEM-24 — ส่ง E-Blast (ถ้ามีในแพ็กเกจ + F7 เปิด)
**อ้างอิง:** F7 (compose → submit for review) · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | `/portal/benefits` แท็บ **Broadcasts** | แสดงโควตา (**Used / Reserved / Remaining / Plan limit**) + ประวัติ |
| 2 | ไป **"Compose E-Blast"** (`/portal/broadcasts/new`) กรอก Subject + Message + Recipients → **"Submit for review"** | toast **"Submitted for admin review."** (target 48 ชม.) |
| 3 | กลับไปแก้ broadcast ที่ submit แล้ว | **แก้ไม่ได้** (immutable after submit); ยกเลิกได้จนกว่าจะอนุมัติ |
| 4 | F7 **ปิด** (break-glass) → เปิด `/portal/benefits?tab=broadcasts` | ถูกบังคับกลับแท็บ Benefits (ไม่โผล่ Broadcasts) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MEM-25 — Timeline ส่วนตัว (redact ข้อมูลภายใน)
**อ้างอิง:** 005 US6-AS3 + 015 US3-AS4 · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิด `/portal/timeline` | subtitle **"Your activity history"**; เห็นเฉพาะกิจกรรมของตัวเอง newest-first |
| 2 | ตรวจรายการ | **ไม่เห็น** override reasons / staff notes (redacted); ไม่เห็นของสมาชิกอื่น |
| 3 | กรอง source/actor/วันที่ + กด **"Load older activity"** | กรอง/โหลดเพิ่มได้ลื่น ไม่ค้าง |
| 4 | source ที่ไม่มีข้อมูล | ไม่ error / ไม่มีแถวว่างหลอก |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MEM-26 — ออกจากระบบ
**อ้างอิง:** F1 sign-out (security-critical) · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | `/portal/account` → การ์ด Appearance → **"Sign out"** | ออกจากระบบ → กลับหน้า sign-in |
| 2 | ลองกด back / เปิด `/portal` หลังออก | ต้องล็อกอินใหม่ (session ถูกเคลียร์) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MEM-27 — read-only kill-switch (READ_ONLY_MODE)
**อ้างอิง:** 005 US5-AS5 (503 read-only-mode) · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิด `READ_ONLY_MODE=true` แล้วลอง Save profile / จ่ายเงิน / ขอ export | การกระทำที่เปลี่ยนข้อมูลได้ **503 `read-only-mode`** |
| 2 | ลองอ่าน (Dashboard / Invoices / Profile) | อ่านได้ปกติ (reads ยังทำงาน) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MEM-28 — manager เข้าพอร์ทัลสมาชิกไม่ได้ (permission)
**อ้างอิง:** 005 US4-AS (role gating) · **บทบาท:** manager / admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ล็อกอิน **manager** แล้วเปิด `/portal` | ไม่เข้าพอร์ทัลสมาชิก (พอร์ทัลสมาชิกเฉพาะ role=member) |
| 2 | ล็อกอิน **admin** เปิด `/portal` | เช่นเดียวกัน — admin/manager ใช้ `/admin`, member ใช้ `/portal` |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## สรุปผล + การลงนามรับรอง (ชุด MEMBER quick-start)

| รายการ | ค่า |
|---|---|
| จำนวน TC ทั้งหมด | 28 |
| ผ่าน | ______ |
| ไม่ผ่าน | ______ (ระบุเลข TC: __________) |
| ข้าม (ฟีเจอร์ปิด/ไม่มีข้อมูล) | ______ (ระบุเลข TC: __________) |
| รันบน (preview URL) | __________________________ |
| วันที่ทดสอบ | __________ |

| บทบาท | ชื่อ | ลายเซ็น | วันที่ |
|---|---|---|---|
| ผู้รับรอง UAT (SweCham) | | | |
| ผู้ดูแลระบบ | | | |

> ปัญหาที่พบให้บันทึกใน `docs/Bug/` หรือ issue และอ้างเลข TC ที่ไม่ผ่าน
