# UAT: รับชำระเงินออนไลน์ (Stripe / PromptPay) — ฝั่ง admin (F5)

> **คู่มือ flow นี้:** [../../user-guide/admin/online-payment.md](../../user-guide/admin/online-payment.md)
> **ที่มา:** `specs/009-online-payment/spec.md` (US3 / US4 + เก็บผลฝั่ง admin จาก US1-AS5, US2-AS5, Edge Cases) + Success Criteria
> **รันบน:** preview deploy (ไม่ใช่ production) · **Stripe test mode** (ต้องมี `stripe listen` ส่ง webhook signing secret เข้า `.env.local`) · บัญชี: admin, manager, member

## ก่อนเริ่ม (Preconditions รวม)
- [ ] `FEATURE_F5_ONLINE_PAYMENT` เปิด และ `tenant_payment_settings` ของ tenant ทดสอบตั้งครบ (environment=`test`, publishable key, account id, เปิดวิธี `card` + `promptpay`, `online_payment_enabled=true`)
- [ ] ตั้งค่า **Settings → Invoicing** ครบ (จาก F4) และมีบริษัทสมาชิกทดสอบ ≥ 1 ราย + แพ็กเกจ active
- [ ] มี **ใบกำกับภาษีสถานะ Issued** อย่างน้อย 1 ใบ (เช่น THB 53,500) สำหรับสมาชิกทดสอบ
- [ ] มีบัญชีทดสอบครบ 3 บทบาท: admin, manager, member (ที่บริษัทตรงกับใบ)
- [ ] บัตรทดสอบ Stripe: สำเร็จ `4242 4242 4242 4242` · 3DS `4000 0027 6000 3184` · ปฏิเสธ `4000 0000 0000 0002` · เงินไม่พอ `4000 0000 0000 9995`

**วิธีกรอก:** แต่ละ TC ทำเครื่องหมายในช่อง "ผล" (☐ ผ่าน หรือ ☐ ไม่ผ่าน) + ใส่หลักฐาน (เลข charge id / เลขใบลดหนี้ / ภาพหน้าจอ / event audit) ในช่อง "หมายเหตุ"

> ℹ️ การจ่ายเงิน "ฝั่งสมาชิก" (กดบัตร / สแกน PromptPay) ใช้เพื่อ **สร้างสถานะตั้งต้น** ของ TC ฝั่ง admin — รายละเอียด UX ฝั่งสมาชิกอยู่ใน UAT member quick-start

---

## TC-PAY-01 — สมาชิกจ่ายด้วยบัตร → ใบเป็น Paid อัตโนมัติ (admin ตรวจผล)
**อ้างอิง:** US1-AS1, FR-004, SC-008 · **บทบาท:** member (ตั้งต้น) → admin (ตรวจ)

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | member: เปิดใบ Issued → Pay now → ใส่บัตร `4242…4242` → จ่าย | ขึ้นหน้าจ่ายสำเร็จ + ดาวน์โหลดใบเสร็จได้ |
| 2 | admin: เปิดใบเดิมที่ `/admin/invoices/[id]` | สถานะใบ **Paid** โดย admin **ไม่ต้องกดบันทึกชำระเอง** |
| 3 | ดูการ์ด **Payment activity** ท้ายหน้า | timeline มี **Payment initiated → Payment succeeded → Invoice marked paid** ตามลำดับ; **Payment initiated** ผู้ทำเป็น **อีเมลสมาชิก** ที่เริ่มจ่าย ส่วน **Payment succeeded** และ **Invoice marked paid** ผู้ทำเป็น **System (Stripe webhook)** (ยืนยันว่า admin ไม่ได้กดบันทึกชำระเอง) |
| 4 | ตรวจอีเมลใบเสร็จของสมาชิก | ได้ใบเสร็จ (PDF) ภายใน ~1 นาที |
| 5 | ตรวจ audit log | มี `payment_initiated`, `payment_succeeded`, `invoice_paid` ครบ |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ (charge id):** ____________________

---

## TC-PAY-02 — สมาชิกจ่ายผ่าน PromptPay QR → ใบเป็น Paid (admin ตรวจผล)
**อ้างอิง:** US2-AS1, US2-AS2 · **บทบาท:** member (ตั้งต้น) → admin (ตรวจ)

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | member: เปิดใบ Issued → Pay with PromptPay → ยืนยัน test-mode confirmation | portal อัปเดตเป็นหน้าจ่ายสำเร็จเองโดยไม่ต้อง refresh |
| 2 | admin: เปิดใบ → Payment activity | timeline ครบเหมือน TC-PAY-01; ใบเป็น **Paid** |
| 3 | ดูวิธีชำระบนใบ (Payment details / Method) | ระบุวิธีเป็น **PromptPay**, **ไม่มี** ข้อมูลบัตร (last-4/brand) ใด ๆ |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-PAY-03 — Payment activity timeline + Charge id + View in Stripe
**อ้างอิง:** US3-AS2 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิดใบที่จ่ายออนไลน์แล้ว → การ์ด **Payment activity** | แสดง event ตามเวลา + ผู้ทำ + timestamp |
| 2 | ดูชิป **Charge id** → กด **Copy charge id** | คัดลอกเลขลง clipboard; toast ที่มองเห็น = **"Charge id copied to clipboard"** (ประกาศ screen-reader/aria-live = **"Copied"**) |
| 3 | กด **View in Stripe** | เปิด Stripe dashboard ในแท็บใหม่ (target=_blank) ไปที่ payment ตรงกัน; ถ้า test mode มีป้าย **Test mode** |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-PAY-04 — ฟิลเตอร์ "Paid online" + คอลัมน์ Method บนรายการ
**อ้างอิง:** US3-AS1 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | มีทั้งใบจ่ายออนไลน์ (card + PromptPay) และใบบันทึกชำระเอง → เปิด `/admin/invoices` กดชิป **Paid online** | เหลือเฉพาะใบที่จ่ายออนไลน์สำเร็จ; โผล่คอลัมน์ **Method** |
| 2 | ดูป้ายในคอลัมน์ Method | ใบ card ขึ้น **Card**; ใบ PromptPay ขึ้น **PromptPay** |
| 3 | ตรวจว่ามีคอลัมน์ charge id ในตารางไหม | **ไม่มี** charge id ในตาราง (อยู่ที่ timeline ของใบเท่านั้น) |
| 4 | กด **Clear filters** | ฟิลเตอร์ถูกล้าง คอลัมน์ Method หาย กลับเป็นรายการเต็ม |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-PAY-05 — manager ดู timeline ได้ แต่ไม่มี action แก้ไข
**อ้างอิง:** US3-AS3, FR-014 · **บทบาท:** manager

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ล็อกอิน manager → เปิดใบที่จ่ายออนไลน์แล้ว | เห็น Payment activity timeline ครบ |
| 2 | มองหาปุ่ม **Issue refund** / Record payment | **ไม่มีปุ่มแก้ไขใด ๆ** (รวมถึงลิงก์ record-manually ใน empty state) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-PAY-06 — คืนเงินเต็มจำนวน (ต้องพิมพ์ยืนยัน)
**อ้างอิง:** US4-AS1, FR-011, FR-012, FR-029(f) · **บทบาท:** admin

> ⚠️ **หมายเหตุ spec:** US4-AS1 (`spec.md:177`) และ SC-008 (`spec.md:395`) ระบุ event `credit_note_issued` อยู่แล้ว (ไม่ใช่ `invoice_credited`) ในชุด audit trail ของการคืนเงิน จึง **ไม่ต้อง** ยก spec-fix สองส่วนนี้ — การเปลี่ยนสถานะใบเป็น Credited ถูกบันทึกด้วย `credit_note_issued` (ดู `F4AuditEventType` ใน `src/modules/invoicing/application/ports/audit-port.ts`) ส่วน token `invoice_credited` ปรากฏเฉพาะเป็น display label ใน F9 admin-audit-viewer (`en/th/sv.json:494`) ที่ **ไม่มี** use-case ปล่อย event (no emitter) เท่านั้น ยืนยันตามโค้ดในขั้นตอนที่ 6

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิดใบ Paid (จ่ายออนไลน์ 53,500) → กด **Issue refund** | กล่อง **"Issue refund?"** เปิด มี Amount + Reason + ข้อมูลเลขใบ/ใบเสร็จ |
| 2 | กรอก Amount = 53,500 (= ยอดคงเหลือ), Reason "Duplicate payment" | โผล่ช่องให้พิมพ์ `REFUND {ชื่อบริษัท}` (เพราะเป็นคืนเต็ม); ปุ่มยืนยันยัง **disabled** |
| 3 | พิมพ์วลีให้ตรงเป๊ะ (ตัวพิมพ์ใหญ่/เล็กตรง) | ปุ่ม **Issue refund** เปิดใช้งาน |
| 4 | กดยืนยัน | ปุ่มขึ้น **Processing refund…** → สำเร็จ: toast แจ้งเลขใบลดหนี้ |
| 5 | ตรวจสถานะใบ + ใบลดหนี้ + Stripe | ใบเดิม **Credited**, Payment **refunded**; ออกใบลดหนี้ผูกกับใบเดิม + ส่งอีเมล; Stripe มี refund |
| 6 | ตรวจ audit | มี `refund_initiated`, `refund_succeeded`, `credit_note_issued` ครบ (การเปลี่ยนสถานะใบเป็น Credited ถูกบันทึกโดย `credit_note_issued` — **ไม่มี** event `invoice_credited`) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ (เลขใบลดหนี้):** ____________________

---

## TC-PAY-07 — คืนเงินบางส่วน (ไม่ต้องพิมพ์ยืนยัน) + คืนเพิ่มได้
**อ้างอิง:** US4-AS5, FR-011, FR-011b · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิดใบ Paid (53,500) → Issue refund → Amount = 3,500, Reason "Contracted tier adjustment" | **ไม่มี** ช่องพิมพ์ยืนยัน (คืนบางส่วน); ปุ่มยืนยันเปิดเมื่อ field ถูกต้อง |
| 2 | กดยืนยัน | ออกใบลดหนี้ 3,500; ใบเดิม **Partially credited**; Payment **partially_refunded** |
| 3 | เปิดใบเดิมอีกครั้ง | ปุ่ม **Issue refund** **ยังอยู่**; Maximum refundable = 50,000 |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-PAY-08 — คืนเงินเกินยอดคงเหลือ ถูกปฏิเสธก่อนเรียก Stripe
**อ้างอิง:** US4-AS6, FR-011b · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ใบที่เคยคืนบางส่วนแล้ว (เหลือ 50,000) → Issue refund → Amount = 60,000 | ช่อง Amount ขึ้น error **"Refund amount exceeds the remaining refundable balance"**; ปุ่มยืนยัน disabled |
| 2 | (หากฝืนส่ง) ตรวจว่ามีการเรียก Stripe ไหม | **ไม่มี** การเรียก Stripe (ปฏิเสธ pre-flight ฝั่ง server 409); ไม่มี audit event ออก |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-PAY-09 — คืนเงินใบที่จ่ายด้วย PromptPay
**อ้างอิง:** US4-AS2 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิดใบ Paid ที่จ่ายด้วย **PromptPay** → Issue refund → คืนเต็ม + พิมพ์ยืนยัน → กด | Stripe คืนเงินกลับบัญชีต้นทางอัตโนมัติ; สมาชิก **ไม่ต้อง** กรอกเลขบัญชีใน portal |
| 2 | ตรวจ flow ใบลดหนี้ | เหมือน card ทุกประการ (ใบลดหนี้ + อีเมล + สถานะ Credited) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-PAY-10 — manager คืนเงินไม่ได้ (ปุ่มไม่มี + API 403)
**อ้างอิง:** US4-AS4, FR-014 · **บทบาท:** manager

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | manager เปิดใบ Paid ที่จ่ายออนไลน์ | **ไม่มี** ปุ่ม Issue refund |
| 2 | ยิง `POST /api/refunds/initiate` ตรง ๆ ด้วย session manager | ตอบ **403** (ไม่ออกใบลดหนี้ ไม่มี refund) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-PAY-11 — Stripe คืนเงินล้มเหลว → ไม่ออกใบลดหนี้ (atomic)
**อ้างอิง:** US4-AS3, FR-013 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | จำลองให้ refund ฝั่ง Stripe ล้มเหลว (เช่น test fixture / balance ไม่พอ) → กด Issue refund | กล่อง **ค้างเปิด** + ขึ้น error ชัดเจน (เช่น "Payment processor temporarily unavailable"); ปุ่มกลับมากดได้ |
| 2 | ตรวจใบ + ใบลดหนี้ | **ไม่มี** ใบลดหนี้ออก; สถานะใบ **ไม่เปลี่ยน**; audit `refund_failed` พร้อม reason code |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-PAY-12 — บัตรถูกปฏิเสธ → ใบยัง Issued + ข้อความสองภาษา (admin ตรวจ)
**อ้างอิง:** US1-AS3, US5-AS1, SC-006 · **บทบาท:** member (ตั้งต้น) → admin (ตรวจ)

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | member: จ่ายด้วยบัตรปฏิเสธ `4000…0002` | ขึ้นข้อความสองภาษา (TH+EN) แนะนำให้ลองบัตรอื่น; ใบยัง **Issued** |
| 2 | admin: เปิดใบ → Payment activity | timeline มี **Payment initiated → Payment failed** (ไม่มี Invoice marked paid) |
| 3 | ตรวจ audit | มี `payment_failed` พร้อม reason code; **ไม่มี** เลขบัตรใน log/audit |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-PAY-13 — จ่ายใบที่ถูก void/paid ไปแล้ว → auto-refund + audit
**อ้างอิง:** US1-AS5, Edge "concurrent manual mark" · **บทบาท:** admin + member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | member เปิดหน้าจ่ายของใบ Issued ค้างไว้ → admin บันทึกชำระ/void ใบนั้น → member กดจ่ายต่อ | ระบบ **ปฏิเสธ pre-flight** หรือ **auto-refund เต็มจำนวน** ผ่าน Stripe |
| 2 | admin: ตรวจ audit | มี `payment_auto_refunded_stale_invoice` หรือ `payment_auto_refunded_concurrent_manual_mark` + แจ้งเตือน admin |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-PAY-14 — webhook ส่งซ้ำ ไม่จ่าย/ออกใบเสร็จ/audit ซ้ำ (idempotent)
**อ้างอิง:** US2-AS5, FR-008, SC-005 · **บทบาท:** admin (ตรวจ) + Stripe CLI

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | จ่ายสำเร็จ 1 ใบ → ใช้ **Stripe Dashboard → Resend** หรือ `stripe events resend <evt_id>` ส่ง event เดิม (event id เดิม) ซ้ำ (อย่าใช้ `stripe trigger` — จะสร้าง event id ใหม่ทุกครั้ง ไม่ใช่การส่งซ้ำ event id เดิม) | webhook ตอบ 200 แต่เป็น no-op |
| 2 | ตรวจ Payment activity + อีเมล + audit | **ไม่มี** payment_succeeded ซ้ำ, **ไม่มี** ใบเสร็จ/อีเมลซ้ำ, **ไม่มี** audit ซ้ำ |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-PAY-15 — webhook ลายเซ็นผิด ถูกปฏิเสธ 401
**อ้างอิง:** Edge "webhook signature mismatch", FR-007, SC-009 · **บทบาท:** ทดสอบ HTTP

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ยิง webhook ที่ลายเซ็นผิด/ไม่มีลายเซ็น | ตอบ **401** ก่อน parse body; ไม่มีการเปลี่ยนสถานะใด ๆ; บันทึก `webhook_signature_rejected` |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-PAY-16 — คืนเงินนอกระบบ (out-of-band) ถูกตรวจจับ + ปฏิเสธ
**อ้างอิง:** FR-011a, Q2 · **บทบาท:** admin (ผ่าน Stripe dashboard) → admin (ตรวจในระบบ)

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | กด **Refund** ใน **Stripe dashboard** โดยตรง (ไม่ผ่านระบบ) บนใบที่จ่ายออนไลน์ | Stripe ยิง `charge.refunded` กลับมา |
| 2 | ตรวจในระบบ | **ไม่มี** ใบลดหนี้ออก, สถานะใบ **ไม่เปลี่ยน**; บันทึก `out_of_band_refund_detected` (charge id + processor refund id) + แจ้งเตือน admin พร้อมลิงก์ runbook |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-PAY-17 — kill-switch ปิด online payment (config) → fallback ฝั่งสมาชิก
**อ้างอิง:** FR-016, FR-030, SC-013 · **บทบาท:** ผู้ดูแล config → member (ตรวจ)

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ตั้ง `FEATURE_F5_ONLINE_PAYMENT=false` (env var — **มีผลทันที**) | ไม่มี Pay now ทันที. **หมายเหตุ MVP:** (ก) การ flip DB-column `online_payment_enabled=false` มี cache ~1h — ใช้ **env var** เพื่อผลทันทีตาม SC-013; (ข) event `online_payment_toggled` **ยังไม่ถูก emit** สำหรับการ flip แบบ config/env (รอ admin payment-settings toggle use-case — per-tenant, future) → ตอนนี้ track ผ่าน deploy/git history |
| 2 | member เปิดใบ Issued | **ไม่มี** ปุ่ม Pay now; เห็นการ์ด **"Online payment unavailable"** + ปุ่ม **Contact administrator** (mailto admin, subject อ้างเลขใบ). **หมายเหตุ MVP:** ปุ่มจะ active เมื่อมี admin email — ปัจจุบันใช้ `BOOTSTRAP_ADMIN_EMAIL` (operator ต้องตั้งใน Vercel runtime env); ถ้าไม่ตั้ง แสดง disabled + "No administrator email is configured yet". per-tenant `contact_email` = future |
| 3 | เปิดกลับ (`true`) → member เปิดใบใหม่ | ปุ่ม Pay now กลับมา |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-PAY-18 — แยก test mode / live mode เด็ดขาด
**อ้างอิง:** FR-010, Edge "sandbox vs live leakage" · **บทบาท:** ทดสอบ webhook

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ส่ง event ผิด environment (เช่น test event เข้า endpoint ที่ตั้ง live หรือกลับกัน) | ถูกปฏิเสธ; บันทึก `payment_environment_mismatch`; ใบ **ไม่เปลี่ยนสถานะ** |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-PAY-19 — tenant isolation: ข้าม tenant ชำระ/คืน/ดู ไม่ได้
**อ้างอิง:** FR-017, SC-010 · **บทบาท:** member/admin tenant A

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ผู้ใช้ tenant A พยายาม ดู/จ่าย/คืน payment ของ tenant B (ผ่าน UI หรือ API ตรง) | ถูกปฏิเสธทุกเส้นทาง (ทั้ง app layer + DB RLS); บันทึก `payment_cross_tenant_probe` |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-PAY-20 — ไม่มีข้อมูลบัตร (PAN/CVV) รั่วใน DB/log/audit (PCI)
**อ้างอิง:** FR-005, SC-007 · **บทบาท:** ผู้ตรวจ compliance

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | หลังจ่ายด้วยบัตรสำเร็จ → สแกน DB rows, log, audit payload, error report | **ไม่พบ** เลขบัตรเต็ม (PAN), CVV, track data; เก็บได้แค่ token id, 4 ตัวท้าย, brand, เดือน/ปีหมดอายุ |
| 2 | ตรวจว่าการกรอกบัตรผ่านฟอร์ม Stripe | server ของเรา **ไม่เคยรับ** ข้อมูลบัตร (รักษา SAQ-A) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-PAY-21 — admin จ่ายแทนสมาชิกไม่ได้
**อ้างอิง:** FR-018 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | admin ยิง `POST /api/payments/initiate` สำหรับใบของสมาชิก | ตอบ **403** (admin-impersonate-pay อยู่นอก scope MVP) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-PAY-22 — เปิดกล่องคืนเงินจาก command palette (?refund=1)
**อ้างอิง:** FR-029 (UX — ครอบคลุมเฉพาะ UX ภายในกล่องคืนเงิน; การเปิดจาก command palette ผ่าน `?refund=1` deep-link + auto-open + clear เป็น affordance ระดับโค้ด ไม่ได้ระบุใน spec.md) · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | command palette → ค้น **Issue refund** → เลือก (พาไป `/admin/invoices/[id]?refund=1`) | กล่องคืนเงิน **เปิดอัตโนมัติ** |
| 2 | ปิดกล่อง (Cancel / Esc / คลิกนอกกล่อง) แล้ว refresh | `?refund=1` ถูกล้างจาก URL; กล่อง **ไม่เด้งซ้ำ** |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## สรุปผล + การลงนามรับรอง (ชุด F5 Online Payment — admin)

| รายการ | ค่า |
|---|---|
| จำนวน TC ทั้งหมด | 22 |
| ผ่าน | ______ |
| ไม่ผ่าน | ______ (ระบุเลข TC: __________) |
| รันบน (preview URL) | __________________________ |
| Stripe mode | ☐ test ☐ live |
| วันที่ทดสอบ | __________ |

| บทบาท | ชื่อ | ลายเซ็น | วันที่ |
|---|---|---|---|
| ผู้รับรอง UAT (SweCham) | | | |
| ผู้ดูแลระบบ | | | |
| ผู้ลงนาม security checklist (PCI/ตรวจ TC-PAY-15/19/20) | | | |

> ปัญหาที่พบให้บันทึกใน `docs/Bug/` หรือ issue และอ้างเลข TC ที่ไม่ผ่าน
> หมายเหตุ scope: F5 MVP **ไม่มีหน้าตั้งค่า payment ใน admin UI** (เป็น env var + migration seed) — TC-PAY-17 จึงทดสอบที่ระดับ config + สังเกตผลฝั่งสมาชิก ไม่ใช่ปุ่ม toggle ในหน้า admin
