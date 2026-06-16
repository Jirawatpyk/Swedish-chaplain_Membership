# คู่มือ: นำเข้าผู้ร่วมงาน + ติดตามโควตาสิทธิประโยชน์ (F6)

> **ใครใช้:** เจ้าหน้าที่สิทธิ์ **admin** (manager ดูรายการ/รายละเอียดได้อย่างเดียว — นำเข้า/แก้/ลบ/ตั้งค่าไม่ได้)
> **เมนู:** Events (`/admin/events`) · นำเข้า CSV (`/admin/events/import`) · ประวัตินำเข้า (`/admin/events/import/history`) · ตั้งค่าการเชื่อมต่อ Settings → EventCreate (`/admin/settings/integrations/eventcreate`)
> **UAT ของ flow นี้:** [../../uat/admin/event-import.uat.md](../../uat/admin/event-import.uat.md)

---

## ⚠️ ก่อนเริ่ม — สิ่งที่ต้องมี

1. ระบบ F6 ต้องเปิดอยู่ (`FEATURE_F6_EVENTCREATE` — ถ้าปิดทุกหน้า events จะขึ้น **404**)
2. มี **สมาชิก (members) + ผู้ติดต่อ (contacts)** ในระบบ F3 อยู่แล้ว — ระบบใช้อีเมล/โดเมน/ชื่อบริษัทของสมาชิกในการ "จับคู่" ผู้ร่วมงาน ถ้ายังไม่มีสมาชิก ผู้ร่วมงานทุกคนจะถูกขึ้นเป็น **Non-member**
3. ถ้าต้องการให้ระบบ **ตัดโควตาสิทธิประโยชน์** อัตโนมัติ ต้องมี **แพ็กเกจ (plan) F2** ที่กำหนดโควตา (Partnership ticket / Cultural ticket) ผูกกับสมาชิกนั้นแล้ว
4. **2 ช่องทางนำเข้า** (เลือกอย่างใดอย่างหนึ่งหรือใช้คู่กัน):
   - **Zapier webhook (อัตโนมัติ)** — ตั้งค่าครั้งเดียวที่ Settings → EventCreate; หลังจากนั้นผู้ลงทะเบียนบน EventCreate จะไหลเข้าระบบเองภายใน ~15 นาที (ดูงานที่ 6)
   - **CSV upload (ทำเอง)** — สำหรับหอการค้าที่ใช้ Eventbrite / Meetup / สเปรดชีต หรือใช้ backfill ย้อนหลัง / กู้คืนตอน Zapier ล่ม (ดูงานที่ 1)
5. **โน้ตภาษา:** หน้าจอ Zapier เป็นภาษาอังกฤษล้วน (ตามที่ระบบแจ้งไว้: _"The Zapier web app is available in English only"_) คำอธิบายในตัวช่วยจะเป็นภาษาที่คุณเลือก แต่ภาพหน้าจอ Zapier จะเป็นอังกฤษเสมอ

---

## ภาพรวมแนวคิดหลัก (จำให้แม่น)

```
ผู้ร่วมงาน 1 คน → 1 registration row
     │
     ├─ (1) จับคู่อีเมล contact ของสมาชิก   → Verified contact
     ├─ (2) จับคู่โดเมนอีเมลของบริษัท         → Verified domain   ── ตัดโควตา (ถ้าเข้าเงื่อนไข)
     ├─ (3) จับคู่ชื่อบริษัทแบบใกล้เคียง        → Likely match
     ├─ (X) จับคู่อัตโนมัติไม่ได้/กำกวม         → Needs review     ── ไม่ตัดโควตา
     └─ (–) ไม่ใช่สมาชิก                       → Non-member        ── ไม่ตัดโควตา (เก็บไว้ดูสถิติ)
```

**ป้าย Match status ที่จะเห็นในตาราง Attendees:**

| ป้าย (Match) | ความหมาย |
|---|---|
| **Verified contact** | อีเมลตรงกับ contact ของสมาชิกในระบบ |
| **Verified domain** | โดเมนอีเมลเป็นของบริษัทสมาชิก |
| **Likely match** | ใกล้เคียงชื่อสมาชิก แต่ไม่ตรงเป๊ะ — **ควรตรวจ** |
| **Non-member** | อีเมล+โดเมนไม่ตรงกับสมาชิกใด |
| **Needs review** | จับคู่อัตโนมัติไม่ได้ — ต้อง **Relink** หรือปล่อยเป็น non-member |

**ป้ายผลต่อโควตา (Quota) ในแต่ละแถว:** `Partner benefit` · `Cultural quota` · `Over quota` (โควตาเต็ม — บันทึกแต่ไม่ตัด) · `Not counted`

> 🔴 **กฎเหล็กของ webhook:** การส่งซ้ำ (`X-Request-ID` เดิม) จะถูกปฏิเสธด้วย HTTP 409 และ **ไม่ตัดโควตาซ้ำ**; ลายเซ็นผิด/หมดอายุเวลา (เกิน 5 นาที) ถูกปฏิเสธด้วย HTTP 401 — ทั้งหมดถูกบันทึก audit log

---

## งานที่ 1 — นำเข้าผู้ร่วมงานจากไฟล์ CSV

**สถานการณ์:** มีไฟล์ CSV รายชื่อผู้ลงทะเบียน (จาก EventCreate / Eventbrite / สเปรดชีต) อยากนำเข้าระบบ

1. ไปที่ **Events** → กดปุ่ม **"Import CSV"** (มุมขวาบน) หรือเปิด `/admin/events/import`
2. ที่ช่อง **Event** เลือกงานจาก dropdown ที่ CSV นี้ควรผูกเข้า
   - ถ้ายังไม่มีงานในระบบ กด **"+ Create new event"** เพื่อสร้างงานใหม่ (กรอก **External ID**, **Event name**, **Start date & time**, **Category** (optional) → **"Create event"**)
   - ⚠️ ค่า Event ที่เลือกจาก dropdown **มีผลเหนือ (override)** คอลัมน์ event ใน CSV เสมอ
3. กดเลือกไฟล์ที่ **"Choose a .csv file"** (หรือลากวาง) — ขนาดไม่เกิน **5 MiB**, UTF-8, คั่นด้วยจุลภาค
   - คอลัมน์ที่จำเป็น: `event_external_id`, `event_name`, `event_start`, `attendee_email`, `attendee_name`
4. ระบบแสดง **Preview 10 แถวแรก** + ป้าย **Detected columns** (คอลัมน์ที่จำเป็นเป็นสีเขียว, คอลัมน์เสริมเป็นสีจาง)
   - ถ้าขึ้นกล่อง **"CSV is missing required columns"** ให้แก้ไฟล์แล้วอัปโหลดใหม่
5. กด **"Confirm and import"** → ระบบประมวลผลทุกแถวด้วย **ตรรกะจับคู่ + โควตาเดียวกันกับ webhook**
6. ดูหน้า **Import complete** (สรุปผล):
   - **Rows imported** / **Already imported** (ข้ามเพราะซ้ำ — idempotent) / **State changed** / **Events created/updated** / **Match breakdown**
   - ถ้ามี **Rows with errors** จะแสดงเลขแถว + เหตุผล (แถวที่ดีถูกนำเข้าต่อไม่หยุด)

> ℹ️ ถ้าระบบสงสัยว่า CSV นี้น่าจะเป็นของงานอื่น (เจอ import ก่อนหน้าด้วยรายชื่อเดียวกันแต่ผูกคนละงานใน 30 วัน) จะขึ้นกล่อง **"This CSV may belong to a different event"** → กด **"Cancel"** เพื่อกลับไปตรวจ หรือ **"Continue anyway"** ถ้าตั้งใจ
> ℹ️ นำเข้าได้ **5 ครั้ง/ชั่วโมง** ถ้าเกินจะขึ้น **"Too many imports"**

---

## งานที่ 2 — ดูรายการงาน + อัตราการจับคู่ (Match rate)

**สถานการณ์:** อยากดูภาพรวมว่าแต่ละงานมีผู้ลงทะเบียนกี่คน จับคู่สมาชิกได้กี่ %

1. เปิด **Events** (`/admin/events`) — ตารางเรียงตามวันที่งาน (ใหม่สุดก่อน)
   - คอลัมน์: **Date** · **Name** · **Category** · **Registrations** · **Partner Benefit** · **Match Rate**
2. ใช้ตัวกรอง (chips) ด้านบนตารางเพื่อแคบผลลัพธ์:
   - **"Counted as partner benefit"** / **"Counted as cultural event"** / **"Show archived events"** / **"Clear filters"**
   - ช่องค้นหา **"Search events by name…"**
3. กดแถวงานเพื่อเข้า **หน้ารายละเอียดงาน** (ดูงานที่ 3)

> หน้านี้จะขึ้น **empty state** ต่างกันตามสถานการณ์: (a) ยังไม่ตั้งค่า integration → ปุ่ม **"Set up EventCreate integration"**; (b) ตั้งค่าแล้วแต่ยังไม่มีข้อมูล → ปุ่ม **"Send a test event"**; (c) งานถูก archive หมด → ปุ่ม **"Show … archived events"**

---

## งานที่ 3 — ดูรายละเอียดงาน + รายชื่อผู้ร่วมงาน

1. ที่หน้ารายละเอียดงาน ส่วนหัวจะแสดง **Match rate** (เช่น _"90% (18 of 20)"_), **Total registrations**, ป้าย **Partner benefit / Cultural event / Archived** และปุ่ม **"View on EventCreate"** (เปิดแท็บใหม่)
2. ตาราง **Attendees** แสดงต่อแถว: ชื่อ/อีเมล/บริษัท · **Match** · **Ticket** · **Quota** · **Registered** · **Actions**
3. กรองรายชื่อด้วย:
   - **"Show unmatched only"** — แสดงเฉพาะแถวที่ยังไม่ได้จับคู่ (สะดวกเวลาตรวจงานใหญ่)
   - **"Filter by payment status"** (All statuses / Paid / Pending / Refunded / Free / Waitlisted / No show)
   - ช่องค้นหา **"Search by email or name…"**

---

## งานที่ 4 — แก้การจับคู่ผิด / จับคู่ผู้ที่ขึ้น non-member (Relink)

**ใช้เมื่อ:** ผู้ร่วมงานขึ้นเป็น **Non-member / Needs review** หรือจับคู่ผิดบริษัท แต่คุณรู้ว่าเป็นสมาชิกคนใด

1. ที่หน้ารายละเอียดงาน → คอลัมน์ **Actions** ของแถวนั้น กด **"Relink"**
2. ในกล่อง **"Relink … to a member"** พิมพ์ค้นหาที่ **"Search by company or contact…"** แล้วเลือกสมาชิกที่ถูกต้อง
3. ระบบจะ: อัปเดต match → **คืนโควตาให้สมาชิกเดิม (credit back)** → ประเมินโควตาสมาชิกใหม่ → แสดงผลใหม่ทันที (ไม่ต้องรีโหลด) → บันทึก audit ทั้งสองฝั่ง
   - สำเร็จขึ้น toast **"Relinked to {ชื่อบริษัท}"**; ถ้าผูกที่เดิมอยู่แล้วขึ้น **"No change"**

> 🔴 แถวที่ PII ถูก **ล้างถาวรแล้ว** (retention-purged / pseudonymised) จะ **Relink ไม่ได้** — จะขึ้นข้อความ _"Cannot relink — attendee PII has been retention-purged…"_ ต้องนำเข้าใหม่ผ่าน CSV ถ้ามีข้อมูลต้นฉบับ

---

## งานที่ 5 — ตั้งค่างานเป็นสิทธิประโยชน์ + ตัดโควตา (Partner benefit / Cultural event)

**ใช้เมื่อ:** ต้องการให้งานนี้ตัดโควตาตั๋วสิทธิประโยชน์ของสมาชิกอัตโนมัติ

1. ที่หน้ารายละเอียดงาน (admin เท่านั้น และงานต้อง **ยังไม่ archive**) ในการ์ดส่วนหัว กดปุ่ม:
   - **"Flag as partner benefit"** — ตัดโควตาตั๋ว Partnership (Diamond/Platinum/Gold) **ต่องาน**
   - **"Flag as cultural event"** — ตัดโควตาตั๋ว Cultural **ต่อปีปฏิทิน** (Corporate tier)
2. ยืนยันในกล่อง → ระบบ **re-evaluate** ทุกแถวที่จับคู่สมาชิกในงานนี้รอบเดียว
   - สมาชิกที่มีโควตาเหลือ → ตัด 1 ใบ; ผู้ที่โควตาเต็มแล้ว → บันทึกแต่ติดป้าย **Over quota** (ไม่ตัด)
3. ยกเลิกการ flag ได้ด้วย **"Remove partner-benefit flag"** / **"Remove cultural-event flag"** → ระบบ **คืนโควตาทั้งหมด** ของงานนั้นกลับให้สมาชิก

> ℹ️ ตั๋วที่สถานะ **Refunded** จะ **คืนโควตา (credit back)** อัตโนมัติ และเก็บแถวไว้เพื่อรายงานย้อนหลัง
> ℹ️ ป้าย **Over quota** เป็นเพียงการแจ้งเตือนในระบบ v1 — ไม่มีการดำเนินการอัตโนมัติ (เช่นออกใบแจ้งหนี้) admin จัดการเองนอกระบบ (เช่นออก invoice ผ่าน F4)

---

## งานที่ 6 — เชื่อมต่อ EventCreate ผ่าน Zapier (ตั้งค่าครั้งเดียว)

**สถานการณ์:** อยากให้ผู้ลงทะเบียนบน EventCreate ไหลเข้าระบบอัตโนมัติ

1. ไปที่ **Settings → EventCreate** (`/admin/settings/integrations/eventcreate`)
2. **Step "Generate secret":** กด **"Generate webhook secret"** → ระบบแสดง **secret แบบครั้งเดียว**
   - กด **"Copy secret to clipboard"** เก็บไว้ใน **password manager** ทันที (ระบบเตือน: _"It will not be shown again"_)
   - ติ๊ก **"I've saved this secret in a password manager"** → **"Continue to Zapier setup"**
3. **Step "Connect Zapier":** ทำตามตัวช่วย 8 ขั้น (Sign in → Create Zap → เลือก trigger EventCreate → เพิ่ม Webhooks by Zapier (POST) แล้ววาง **Webhook URL** → map ฟิลด์ → เพิ่ม header **X-Chamber-Signature** → Test → Publish) แล้วกด **"I've set up the Zap — continue"**
4. **Step "Test & manage":** กด **"Send test event"** → ภายใน ~30 วินาทีจะขึ้น **"Test event delivered successfully"** และเห็นรายการใน **Recent deliveries** (Signature: Verified)
5. ดูสถานะการส่งล่าสุดได้ที่ตาราง **Recent deliveries** (Received · Request ID · Signature · Processing) ติ๊ก **"Include test deliveries"** เพื่อรวม test

---

## งานที่ 7 — หมุนเปลี่ยน secret (Rotate) เมื่อ secret หลุด

**ใช้เมื่อ:** สงสัยว่า secret รั่ว (เผลอ commit ลง Git / ติดในภาพหน้าจอ)

1. ที่ Settings → EventCreate (Step "Test & manage") กด **"Rotate secret"**
2. ยืนยันในกล่อง **"Rotate webhook secret?"** → กด **"Rotate now"**
3. ระบบสร้าง secret ใหม่ (แสดงครั้งเดียว) — เก็บทันที แล้ว **อัปเดต secret ใน Zapier ภายใน 24 ชั่วโมง**

> 🔴 secret เก่ายังใช้ได้ต่ออีก **24 ชั่วโมง (grace period)** เพื่อไม่ให้ registration ที่ค้างอยู่หลุด; หลัง 24 ชม. secret เก่าจะถูกปฏิเสธ (HTTP 401) — ระบบแสดงเวลาเส้นตาย _"Old secret still verifies until {เวลา}"_

---

## งานที่ 8 — Archive งาน (ปิดงาน + คืนโควตาทั้งหมด)

**ใช้เมื่อ:** งานถูกยกเลิก/ไม่ต้องการนับโควตาของงานนั้นอีกแล้ว

1. ที่หน้ารายละเอียดงาน (admin, งานยังไม่ archive) กด **"Archive event"**
2. ยืนยันในกล่อง **"Archive this event?"** → กด **"Archive"**
3. ระบบจะ: ตั้งงานเป็น **quota-neutral** → **คืนโควตาทุกใบ** (partnership + cultural) ของงานนั้นให้สมาชิก → ซ่อนงานออกจากรายการ default (ดูได้ผ่านตัวกรอง **"Show archived events"**) → บันทึก audit

> 🔴 **ไม่มีปุ่ม Un-archive ในเวอร์ชัน v1** — archive แล้ว flag สิทธิประโยชน์/relink ของงานนั้นจะทำต่อไม่ได้ (งานเป็น quota-neutral); ถ้าจำเป็นต้องนำกลับให้ re-import ใหม่ผ่าน webhook

---

## งานที่ 9 — ลบข้อมูลส่วนบุคคล (Erase PII) ตามคำขอ PDPA/GDPR

**ใช้เมื่อ:** ผู้ร่วมงานยื่นคำขอลบข้อมูล (PDPA §30 / GDPR Art. 17)

1. หาเลข `eventId` และ `registrationId` ของแถวที่ต้องการลบ (จากหน้ารายละเอียดงาน) แล้วเปิด URL โดยตรง:
   `/admin/events/{eventId}/registrations/{registrationId}/erase`
   - ⚠️ การลบ PII **ไม่มีปุ่มในตาราง Attendees** — ต้องเข้าผ่าน URL deep-link นี้ (หน้าจะเปิดกล่องยืนยันให้อัตโนมัติ)
2. ในกล่อง **"Erase personal data for {ชื่อ}?"** กรอก **"Reason for erasure"** (บังคับ — เช่น GDPR Art. 17 / PDPA §30)
3. กด **"Erase PII"** → ระบบ: ลบ ชื่อ/อีเมล/บริษัท ออกจากแถวถาวร → **คืนโควตา** ที่เคยตัด → เก็บ audit (admin, เวลา, เหตุผล) ไว้ตามกฎหมาย
   - สำเร็จขึ้น **"Personal data erased"** พร้อมสรุปโควตาที่คืน

> 🔴 ลบ PII แล้ว **กู้คืนไม่ได้** — ต้องนำเข้าใหม่ผ่าน CSV ถ้ามีข้อมูลต้นฉบับ; แถวที่ลบแล้วจะ **Relink ไม่ได้** อีก

---

## งานที่ 10 — ดูประวัติการนำเข้า CSV + ดาวน์โหลดแถวที่ error

1. เปิด **`/admin/events/import/history`** (หรือกด **"Back to import"** / ลิงก์ในหน้าผลนำเข้า)
2. ตารางแสดง: **Uploaded** · **File** · **Source** · **Outcome** (Completed/Partial/Failed/…) · **Processed/Skipped/Failed** · **Actions**
3. ถ้า import ใดมีแถว error กด **"Download error CSV"** เพื่อโหลดเฉพาะแถวที่พลาด → แก้ใน Excel → อัปโหลดใหม่ (แถวที่นำเข้าแล้วจะถูกข้ามอัตโนมัติ)

> ℹ️ error CSV เก็บไว้ **30 วัน** หลังจากนั้นจะขึ้นป้าย **"Expired"** — ต้อง re-run import เพื่อสร้างใหม่

---

## ❓ คำถามที่พบบ่อย / ข้อควรรู้

| คำถาม | คำตอบ |
|---|---|
| ผู้ร่วมงานใช้ **อีเมลส่วนตัว** (gmail/yahoo) จับคู่ได้ไหม? | โดเมนส่วนตัวถูกข้ามการจับคู่โดเมน → ตกไปจับคู่ชื่อบริษัท หรือขึ้น **Non-member/Needs review** ให้ relink เอง |
| นำเข้า CSV ซ้ำไฟล์เดิมจะตัดโควตาซ้ำไหม? | ไม่ — แถวซ้ำขึ้น **"Already imported"** (idempotent) ไม่ตัดโควตาซ้ำ |
| ทำไม manager ไม่เห็นปุ่ม Import / Relink / Archive / Flag? | manager **อ่านอย่างเดียว** บน `/admin/events`; การกระทำใน events คืน **403**, หน้า **Settings → EventCreate** คืน **404** (กันการเปิดเผยว่ามีหน้า secret อยู่) |
| วันที่/เวลาในตารางเป็นโซนเวลาอะไร? | แสดงเป็น **Asia/Bangkok** เสมอ (เก็บภายในเป็น UTC); ภาษาไทยแสดง พ.ศ. |
| งานเดียวกันถูกส่งซ้ำจาก Zapier? | กันด้วย `X-Request-ID` (idempotency) → HTTP 409 ไม่มี side effect; ดูใน Recent deliveries = "Duplicate" |
| Zapier ล่ม/ขาดช่วง ทำยังไง? | ใช้ **CSV upload (งานที่ 1)** backfill; แถวซ้ำถูกข้ามอัตโนมัติ |
| งานยังไม่มี registration เลย เห็นในรายการไหม? | เห็น (Registrations = 0) ถ้า EventCreate ยิง event-only trigger |

---

## 🔴 สรุปสิ่งที่ "ย้อนกลับไม่ได้" (ระวังให้มาก)

1. **Erase PII** (งานที่ 9) → ลบข้อมูลส่วนบุคคลถาวร กู้คืนไม่ได้
2. **Archive event** (งานที่ 8) → ไม่มี Un-archive ใน v1; งานเป็น quota-neutral ถาวร
3. **Rotate secret** (งานที่ 7) → secret เก่าหมดอายุใน 24 ชม.; ต้องอัปเดต Zapier ทัน
4. **PII ที่ถูก retention-purged** → Relink ไม่ได้อีก (ต้อง re-import ผ่าน CSV)
