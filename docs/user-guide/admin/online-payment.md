# คู่มือ: รับชำระเงินออนไลน์ (Stripe / PromptPay) — ฝั่ง admin (F5)

> **ใครใช้:** เจ้าหน้าที่สิทธิ์ **admin** (manager **ดู timeline ได้อย่างเดียว** — ออก refund ไม่ได้ · member ชำระเงินเองผ่าน portal)
> **เมนู:** Invoices (`/admin/invoices`) → เปิดใบ → ดูที่การ์ด **Payment activity** ท้ายหน้า · ปุ่ม **Issue refund** บนใบที่ชำระแล้ว
> **UAT ของ flow นี้:** [../../uat/admin/online-payment.uat.md](../../uat/admin/online-payment.uat.md)

---

## ⚠️ ก่อนเริ่ม — สิ่งที่ต้องมี

1. **ระบบ F5 ต้องเปิดอยู่** — ตั้งค่า env `FEATURE_F5_ONLINE_PAYMENT` (kill-switch ทั้งฟีเจอร์) ให้เปิด
   - ถ้าปิด → หน้าจ่ายเงินฝั่งสมาชิกจะซ่อนปุ่ม Pay-now และ webhook ของ Stripe ตอบ 503 (ฝั่ง admin ยังเปิดใบ/ดู timeline ได้ตามปกติ)
2. **ตั้งค่า Stripe ของหอการค้าให้ครบ** (ทำครั้งเดียว ตอน onboarding) — F5 MVP **ไม่มีหน้าตั้งค่าใน UI**:
   - Stripe secret key / publishable key / account id / webhook secret อยู่ใน **Vercel env vars เท่านั้น** (zod ตรวจตอนบูต — env ผิด แอปไม่สตาร์ท)
   - แถว `tenant_payment_settings` (เปิด/ปิด online payment ระดับ tenant, วิธีที่เปิด `card`/`promptpay`, environment `test`/`live`) ถูก **seed ด้วย migration ครั้งเดียว** — ไม่ใช่หน้าจอ admin (จะมีหน้า `/admin/payment-settings` ใน release ถัดไปหลัง MVP)
   - 🔴 ห้ามให้เจ้าหน้าที่จัดการ "บัตรเครดิต" เอง — การกรอกบัตรทำผ่านฟอร์มของ Stripe (Elements) บน portal สมาชิกเท่านั้น (รักษา PCI SAQ-A) ระบบ **ไม่เก็บเลขบัตร/CVV** เด็ดขาด
3. ต้องมี **ใบกำกับภาษีสถานะ Issued** (จาก F4) ให้สมาชิกจ่าย — F5 ไม่สร้างใบเอง (ดูคู่มือ F4 [invoicing.md](invoicing.md))
4. การชำระจริงทดสอบบน **preview deploy + Stripe test mode** (มี `stripe listen` ส่ง webhook signing secret เข้า `.env.local`)

> ℹ️ ฝั่งสมาชิก (กด Pay now → จ่ายบัตร / สแกน PromptPay QR) อยู่ใน **คู่มือสมาชิก (member quick-start)** — เอกสารนี้ครอบเฉพาะงานฝั่ง admin: เปิด/ปิดการชำระ, ดูกิจกรรมการชำระ, และการคืนเงิน (refund)

---

## ภาพรวมการทำงาน F5 (จำให้แม่น)

F5 = "หน้ารับชำระ" ของใบที่ F4 ออกไว้แล้ว — เมื่อสมาชิกจ่ายสำเร็จ ระบบจะวิ่งเข้าสู่ flow ของ F4 อัตโนมัติ (ไม่ต้องให้ admin บันทึกชำระเอง):

```
สมาชิกกด Pay now (portal) ──► จ่ายบัตร / สแกน PromptPay QR
                                      │  (Stripe ยิง webhook กลับมา)
                                      ▼
            payment_succeeded ──► เรียก F4 markPaid อัตโนมัติ ──► ใบเป็น "Paid"
                                      │                              + ออกใบเสร็จ + ส่งอีเมลใบเสร็จ
                                      ▼
                          แสดงใน Payment activity timeline (ฝั่ง admin)

สถานะ Payment:  pending → succeeded → (partially_refunded) → refunded
สถานะใบ (F4):   issued  → paid     → (partially_credited)  → credited
```

> 🔴 **กฎเหล็ก refund:** F5 MVP คืนเงิน **ผ่านหน้า admin ของระบบนี้เท่านั้น** — ห้ามกด Refund ใน Stripe dashboard เอง การ refund นอกระบบ (out-of-band) จะถูก webhook **ปฏิเสธ** + บันทึก audit `out_of_band_refund_detected` + แจ้งเตือน admin (ดู `docs/runbooks/out-of-band-refund.md`) เพราะจะไม่มีใบลดหนี้ (credit note) ออกให้ → บัญชีสองระบบไม่ตรงกัน

---

## งานที่ 1 — เปิด/ปิดการรับชำระออนไลน์ (kill-switch)

**สถานการณ์:** ต้องเปิดให้สมาชิกเริ่มจ่ายออนไลน์ได้ หรือปิดฉุกเฉินเมื่อ Stripe มีปัญหา

> F5 MVP **ไม่มีปุ่มเปิด/ปิดในหน้า admin** — ทำที่ระดับ config:

1. **เปิดทั้งฟีเจอร์ (ทุก tenant):** ตั้ง env `FEATURE_F5_ONLINE_PAYMENT=true` ใน Vercel แล้ว redeploy
2. **เปิด/ปิดเฉพาะ tenant:** ค่า `tenant_payment_settings.online_payment_enabled` (true/false) — แก้ผ่าน migration/seed
3. เมื่อปิด (ค่าใดค่าหนึ่งเป็น false หรือตั้งค่าไม่ครบ) ฝั่งสมาชิกจะ **ไม่เห็นปุ่ม Pay now** แต่เห็นการ์ดแจ้ง **"Online payment unavailable"** พร้อมปุ่ม **Contact administrator** (เปิดอีเมลถึง admin ของหอการค้า) แทน
4. การปิดมีผลภายใน 1 รอบ request (ไม่แคชค้างเกิน ~60 วิ); payment-intent ที่ค้างอยู่ต้องให้ admin สั่งยกเลิกผ่าน Stripe

> ℹ️ ทุกครั้งที่เปลี่ยนค่านี้ ระบบบันทึก audit `online_payment_toggled` / `tenant_payment_settings_updated`

---

## งานที่ 2 — ดูกิจกรรมการชำระของใบ (Payment activity timeline)

**สถานการณ์:** ตรวจว่าสมาชิกจ่ายใบนี้แล้วหรือยัง / จ่ายด้วยวิธีไหน / กระทบยอดกับ Stripe

1. ไปที่ **Invoices** → เปิดใบที่ต้องการ → เลื่อนลงท้ายหน้า การ์ด **"Payment activity"**
2. timeline แสดงเหตุการณ์ตามเวลา: **Payment initiated → Payment succeeded → Invoice marked paid** (และ **Refund initiated / Refund completed** ถ้ามีคืนเงิน) พร้อม **ผู้ทำรายการ** + เวลา
   - การชำระออนไลน์ขึ้นผู้ทำเป็น **"System (Stripe webhook)"**; ส่วนการบันทึกชำระเอง (manual record) **ไม่ขึ้นเป็น event ใน timeline** — จะปรากฏเป็นสถานะ **"Paid via manual record"** (ดูข้อ 5) โดยมีรายละเอียดอยู่ในส่วน **Payment details**
3. ถ้าใบจ่ายสำเร็จ จะมีชิป **Charge id** (เลขอ้างอิงจาก Stripe) พร้อมปุ่ม **Copy charge id** และลิงก์ **View in Stripe** (เปิด Stripe dashboard ในแท็บใหม่) ใช้กระทบยอดสิ้นเดือน
   - ถ้าเป็น test mode จะมีป้าย **Test mode** กำกับ
4. ใบที่ **ยังไม่จ่ายออนไลน์** → การ์ดขึ้น empty state **"No online payment activity"** (admin จะเห็นลิงก์ **Record a payment manually** ถ้าใบยัง Issued)
5. ใบที่ **บันทึกชำระเอง** (เงินสด/โอน/เช็ค ผ่าน F4 Record payment) → ขึ้น **"Paid via manual record"** (timeline ติดตามเฉพาะการชำระออนไลน์; รายละเอียดการชำระเองอยู่ในส่วน Payment details ด้านบน)

> manager เปิดดู timeline นี้ได้ครบ แต่ **ไม่เห็นปุ่มที่แก้ไขข้อมูล** (refund / record-payment)

---

## งานที่ 3 — กรองดูเฉพาะใบที่ "จ่ายออนไลน์" (กระทบยอด)

**สถานการณ์:** สิ้นเดือน อยากเห็นเฉพาะใบที่จ่ายด้วยบัตร/PromptPay เพื่อเทียบกับ Stripe

1. ไปที่ **Invoices** → กดชิป **"Paid online"** (มุมแถบฟิลเตอร์)
2. รายการจะเหลือเฉพาะใบที่มีการชำระออนไลน์สำเร็จ และโผล่คอลัมน์ **Method** เพิ่ม พร้อมป้าย **Card** / **PromptPay** ในแต่ละแถว
3. ต้องการเลข charge id เต็ม → คลิกเข้าใบนั้น แล้วดูใน Payment activity (งานที่ 2) — เลข charge id **ไม่แสดงในตารางรายการ** (ยาวเกินไป ทำให้ตารางรก)
4. กด **Clear filters** เพื่อล้างฟิลเตอร์ทั้งหมด

---

## งานที่ 4 — คืนเงิน (Issue refund) ใบที่ชำระออนไลน์แล้ว

**ใช้เมื่อ:** ต้องคืนเงินใบที่ **จ่ายออนไลน์สำเร็จ** (จ่ายซ้ำ, ลดชั้นสมาชิก, ยกเลิกสมาชิก ฯลฯ) — รองรับ **คืนเต็มหรือบางส่วน** และคืนบางส่วนได้หลายครั้งจนครบยอด

1. เปิดใบสถานะ **Paid** หรือ **Partially credited** (ที่จ่ายผ่าน Stripe) → กดปุ่ม **"Issue refund"** (อยู่ข้างปุ่ม Issue credit note)
   - ปุ่มนี้โผล่เฉพาะเมื่อมีการชำระออนไลน์สำเร็จและยังมี **ยอดคงเหลือที่คืนได้ > 0**
2. ในกล่อง **"Issue refund?"** กรอก:
   - **Refund amount (THB)** — จำนวนเงิน (มากกว่า 0 และ ≤ ยอดคงเหลือ) ระบบโชว์ **Maximum refundable: … THB** ใต้ช่องสด ๆ
   - **Reason** — เหตุผล (บังคับ, ≤ 500 ตัวอักษร, บรรทัดเดียว) เหตุผลนี้จะกลายเป็นบรรทัดในใบลดหนี้
3. **ถ้าเป็นการคืนเต็มจำนวน** (ใส่ยอด = ยอดคงเหลือ) จะมีช่องพิเศษให้ **พิมพ์ยืนยัน** ข้อความ `REFUND {ชื่อบริษัทสมาชิก}` ให้ตรงเป๊ะ (ตัวพิมพ์ใหญ่/เล็กต้องตรง) ปุ่มยืนยันจึงเปิด
   - การคืนบางส่วน **ไม่ต้อง** พิมพ์ยืนยัน
4. กด **"Issue refund"** → ปุ่มขึ้น **"Processing refund…"** → เมื่อสำเร็จ:
   - Stripe คืนเงิน (PromptPay คืนกลับบัญชีธนาคารต้นทางอัตโนมัติ — สมาชิกไม่ต้องกรอกเลขบัญชี)
   - ระบบ **ออกใบลดหนี้ (credit note)** ผูกกับใบเดิม + ส่งอีเมลแจ้ง + แนบ PDF ใบลดหนี้
   - คืน **เต็ม** → ใบเดิมเป็น **Credited**, Payment เป็น **refunded**
   - คืน **บางส่วน** → ใบเดิมเป็น **Partially credited**, Payment เป็น **partially_refunded** (ปุ่ม Issue refund ยังอยู่ คืนเพิ่มได้จนครบ)
   - toast แจ้งเลขใบลดหนี้ที่ออก

> 🔴 refund **ยกเลิกไม่ได้** หลังกดสำเร็จ — และระบบเป็นแบบ atomic: ถ้า Stripe คืนเงินไม่สำเร็จ จะ **ไม่ออกใบลดหนี้** (กล่องค้างเปิดพร้อมข้อความ error)
> ℹ️ ใส่ยอดเกินยอดคงเหลือจะถูกปฏิเสธทันที (ไม่เรียก Stripe) ด้วยข้อความ "Refund amount exceeds the remaining refundable balance"

---

## งานที่ 5 — เปิด refund ด้วย command palette (ทางลัด)

- กด command palette → ค้น **"Issue refund"** → ระบบพาไป `/admin/invoices/[id]?refund=1` ซึ่ง **เปิดกล่องคืนเงินให้อัตโนมัติ** (ทำงานได้บนใบที่มี refund ได้เท่านั้น)
- ปิดกล่อง (Cancel / Esc / คลิกนอกกล่อง) จะล้าง `?refund=1` ออกจาก URL ให้เอง — refresh แล้วกล่องไม่เด้งซ้ำ

---

## ❓ คำถามที่พบบ่อย / ข้อควรรู้

| คำถาม | คำตอบ |
|---|---|
| ตั้งค่า Stripe / เปิด-ปิด online payment ตรงไหนใน UI? | F5 MVP **ไม่มีหน้าตั้งค่าใน UI** — เป็น env var (`FEATURE_F5_ONLINE_PAYMENT`) + แถว `tenant_payment_settings` ที่ seed ด้วย migration (หน้า admin จะมาใน release หลัง MVP) |
| admin จ่ายเงินแทนสมาชิกได้ไหม? | **ไม่ได้** ใน MVP — `POST /api/payments/initiate` คืน 403 ให้ role admin; การจ่ายต้องเป็น member ที่บริษัทตรงกับใบ |
| ต้องกด "บันทึกชำระ" เองหลังสมาชิกจ่ายออนไลน์ไหม? | **ไม่ต้อง** — webhook ของ Stripe เรียก F4 markPaid + ออกใบเสร็จ + ส่งอีเมลให้อัตโนมัติ |
| manager ทำไมไม่เห็นปุ่ม Issue refund? | manager เป็นสิทธิ์ **อ่านอย่างเดียว** บนการเงิน — ดู timeline ได้ แต่คืนเงินไม่ได้ (server ตอบ 403 ถ้าเรียก API ตรง) |
| เผลอกด Refund ใน Stripe dashboard ไปแล้ว ทำไง? | ระบบจะตรวจเจอตอน webhook (`out_of_band_refund_detected`) แล้ว **ไม่ออกใบลดหนี้ + ไม่เปลี่ยนสถานะใบ** + แจ้ง admin → แก้ตามคู่มือ `docs/runbooks/out-of-band-refund.md` (void refund นั้นใน Stripe ถ้ายังได้ หรือติดต่อ support) |
| คืนเงินบางส่วนได้กี่ครั้ง? | ได้หลายครั้ง สะสมกันจนครบยอดที่จ่าย (`Σ refunds ≤ ยอดที่จ่าย`) แต่ละครั้งออกใบลดหนี้ 1 ใบ |
| ส่ง webhook ซ้ำจะจ่าย/ออกใบเสร็จซ้ำไหม? | ไม่ — ระบบ idempotent บน processor event id; เหตุการณ์เดิมที่มาซ้ำเป็น no-op |
| เลขบัตรเครดิตเก็บที่ไหน? | **ไม่เก็บ** — เก็บได้แค่ token id, 4 ตัวท้าย, brand, เดือน/ปีหมดอายุ (PCI SAQ-A); การกรอกบัตรทำบนฟอร์ม Stripe ฝั่งสมาชิก ไม่ผ่าน server ของเรา |
| Test mode กับ Live mode ปนกันได้ไหม? | ไม่ — event ผิด environment ถูกปฏิเสธ + บันทึก `payment_environment_mismatch` |

---

## 🔴 สรุปสิ่งที่ "ย้อนกลับไม่ได้ / ต้องระวัง" (ระวังให้มาก)

1. **Issue refund** → คืนเงินจริงผ่าน Stripe + ออกใบลดหนี้ถาวร → **ยกเลิกไม่ได้** (คืนเต็มต้องพิมพ์ยืนยัน `REFUND {บริษัท}`)
2. **คืนเงินผ่าน Stripe dashboard เอง (out-of-band)** → ระบบปฏิเสธ ไม่ออกใบลดหนี้ → บัญชีสองระบบไม่ตรง (ใช้หน้า admin เท่านั้น)
3. **ปิด `FEATURE_F5_ONLINE_PAYMENT`** → ฝั่งสมาชิกหยุดจ่ายออนไลน์ทันที + webhook ตอบ 503 (intent ค้างต้องยกเลิกใน Stripe)
4. **ห้ามแตะข้อมูลบัตรเครดิตของสมาชิก** — ทำลาย PCI SAQ-A scope (ship blocker)
