# คู่มือ: แดชบอร์ด + Audit Log + Timeline + Directory + Export (F9 Insights)

> **ใครใช้:** เจ้าหน้าที่สิทธิ์ **admin** และ **manager** (ทั้งสองเห็นแดชบอร์ด/Audit/Directory เหมือนกัน รวมยอดรายได้ด้วย — F9 เป็นหน้า "ดูอย่างเดียว" ไม่มีปุ่มแก้การเงิน) · บางหน้าสมาชิก (member) ดูของตัวเองได้ใน portal
> **เมนู (ฝั่ง staff):** Dashboard (`/admin`) · **Directory** (ป้ายบน sidebar ซ้าย; หัวข้อหน้าคือ "Member directory") (`/admin/directory`) · Audit log (`/admin/audit`) · ต่อ member: Benefits + Timeline ในหน้า member detail
> **เมนู (ฝั่ง member portal):** เมนูนำทางจริง = Dashboard (`/portal`) · Profile (`/portal/profile`) · Invoices (`/portal/invoices`) · Benefits (`/portal/benefits`); Account เข้าผ่าน avatar dropdown (`/portal/account`)
> **เข้าถึงได้แต่ไม่อยู่บนเมนู (member portal):** Activity timeline (`/portal/timeline` — ผ่านการ์ด Recent activity บน dashboard) · Directory listing (`/portal/profile/directory` — จากหน้า Profile) · Export my data (`/portal/account#data-privacy` — ในการ์ด Data & privacy ของ Account hub)
> **UAT ของ flow นี้:** [../../uat/admin/dashboard.uat.md](../../uat/admin/dashboard.uat.md)

---

## ⚠️ ก่อนเริ่ม — สิ่งที่ต้องมี

1. **เปิดฟีเจอร์ F9** — ต้องตั้ง `FEATURE_F9_DASHBOARD=true` ใน Vercel env ของ tenant
   - ถ้าปิดอยู่ หน้า `/admin` จะแสดง **placeholder roadmap (F3–F6)** แทนแดชบอร์ดจริง และหน้า `/admin/audit` · `/admin/directory` · `/portal/profile/directory` จะขึ้น **404 (Not found)**
2. **ตั้งค่า secret สำหรับลิงก์ดาวน์โหลด** — เมื่อเปิด `FEATURE_F9_DASHBOARD=true` แล้ว **ต้องตั้ง** `EXPORT_DOWNLOAD_TOKEN_SECRET` (≥32 ตัวอักษร และ **ต้องไม่ซ้ำ** กับ secret ตัวอื่น) ด้วย ไม่งั้น **แอปจะ refuse to start (boot error)** — secret นี้ใช้เซ็นลิงก์ดาวน์โหลด E-Book / GDPR archive แบบใช้ครั้งเดียว
3. มีข้อมูลจาก F1–F8 อยู่บ้าง (สมาชิก, ใบแจ้งหนี้, การชำระ, broadcast, การต่ออายุ) — แดชบอร์ดเป็น "ชั้นมองภาพรวม" ที่ดึงจากข้อมูลที่ F1–F8 สร้างไว้ ถ้า tenant ว่างเปล่าทุกส่วนจะขึ้น **empty state** (ไม่ใช่ error)

> 🔵 **F9 ไม่สร้างข้อมูลใหม่** (ยกเว้น 3 อย่าง: ตั้งค่าการแสดงใน directory, ปิดการ์ด insight, และคำขอ export) — มันแค่ "อ่าน + รวม + แสดง" ข้อมูลที่มีอยู่แล้ว ดังนั้นทุกหน้าจึงปลอดภัยที่จะกดดู

---

## ภาพรวม 6 ส่วนของ F9 (จำให้แม่น)

```
ฝั่งเจ้าหน้าที่ (staff)                              ฝั่งสมาชิก (member portal)
────────────────────────                            ─────────────────────────
1. Dashboard /admin           ── KPI + แนวโน้ม + ฟีดกิจกรรม + insight
2. Audit log /admin/audit     ── ใครทำอะไร เมื่อไหร่ (ค้น/กรอง/export)     —  (staff-only)
3. Member timeline            ── ประวัติรวมทุกแหล่ง (invoice/payment/...) ◄──► /portal/timeline (ของตัวเอง)
4. Member benefits            ── สิทธิประโยชน์ใช้ไป/โควตา                  ◄──► /portal/benefits (ของตัวเอง)
5. Directory /admin/directory ── ค้นสมาชิก + สร้าง E-Book(PDF)/JSON         ◄──► /portal/profile/directory (ตั้งค่าการแสดงของตัวเอง)
6. GDPR export (on-behalf)    ── ออก archive ให้สมาชิก (data-subject req)  ◄──► /portal/account#data-privacy (ของตัวเอง)
```

> 🔵 **ตัวเลขบนแดชบอร์ดเป็น "snapshot" (ภาพถ่าย ณ เวลาหนึ่ง)** ระบบรีเฟรชอัตโนมัติทุก ~5 นาที (+ รีเฟรชเมื่อมีเหตุการณ์สำคัญ เช่น บันทึกชำระเงิน อนุมัติ broadcast เปลี่ยนสถานะสมาชิก) มุมบนหน้าจะบอก **"As of {เวลา}"** เสมอ ส่วน **Recent activity (ฟีดกิจกรรม)** ดึงสด ไม่ต้องรอ snapshot

---

## งานที่ 1 — อ่านแดชบอร์ดภาพรวมหอการค้า

**สถานการณ์:** เปิดมาตอนเช้าอยากรู้ "หอการค้าสุขภาพดีแค่ไหนตอนนี้"

1. ไปที่ **Dashboard** (`/admin` — ลิงก์แรกสุดบนเมนูซ้าย)
2. แถบ **Key metrics** บนสุด แสดง KPI 4 ตัว:
   - **Total members** (สมาชิกทั้งหมด) · **Active members** (ใช้งานอยู่) · **At-risk members** (เสี่ยงหลุด) · **Paid revenue (YTD)** (รายได้ที่ชำระแล้วสะสมทั้งปี)
3. ดู **"As of {time}"** ใต้หัวข้อ — บอกว่าตัวเลขสดถึงเวลาไหน (ถ้าเก่าเกินไปรอ ~5 นาทีให้ cron รีเฟรช)
4. การ์ด **Needs attention** (ทางซ้าย) — รวมงานที่ต้องจัดการ พร้อมจำนวนและลิงก์ไปยังรายการที่กรองไว้แล้ว:
   - **Overdue invoices** → ลิงก์ไป Invoices ที่กรอง overdue
   - **At-risk members** → ลิงก์ไป Members ที่กรอง 3 ระดับเสี่ยง (critical/at-risk/warning)
   - **Broadcasts awaiting approval** → ลิงก์ไป Broadcasts
   - ถ้าไม่มีอะไรค้าง การ์ดจะขึ้น **"All clear — nothing needs attention right now."**
5. การ์ด **Smart insights** (ทางขวา) — คำแนะนำที่ระบบหาให้ เช่น "{n} members have unused E-Blast quota" · กด **Dismiss insight** เพื่อปิดการ์ดที่ไม่สนใจ
6. กราฟ 2 ตัว: **Revenue trend (12 months)** และ **Member growth (12 months)** — แต่ละกราฟมีตารางข้อมูลสำหรับ screen reader และไม่พึ่งสีอย่างเดียว
7. การ์ด **Recent activity** (ล่างสุด) — ฟีดเหตุการณ์ล่าสุดเรียงใหม่→เก่า มีผู้กระทำ + การกระทำ + เวลา · กด **Refresh** เพื่อดึงล่าสุด

> ℹ️ **manager เห็นทุกอย่างเหมือน admin** รวมยอดรายได้และกราฟรายได้ (manager เป็น "read-only on finance" — ดูเงินได้ แต่ทั้งหน้าไม่มีปุ่มแก้อยู่แล้ว)
> ℹ️ **member เข้า `/admin` ไม่ได้** — ระบบจะพากลับไป portal

---

## งานที่ 2 — ค้น Audit Log + Export (ใครทำอะไร เมื่อไหร่)

**ใช้เมื่อ:** ต้องตอบคำถาม compliance/เหตุการณ์ เช่น "ใครเปลี่ยน tier สมาชิกรายนี้เดือนที่แล้ว" / "ขอ log การเปลี่ยน role ทั้งปีให้ผู้ตรวจสอบ"

1. ไปที่ **Audit log** (`/admin/audit` — อยู่ในหมวด System บนเมนู)
2. ใช้แถบ **Filter audit events** กรองได้ทีละตัวหรือหลายตัวรวมกัน:
   - **Event type** — เลือกชนิดเหตุการณ์ (ครบทุกชนิดในระบบ: member/invoice/broadcast/renewal/plan/event/auth/payment...)
   - **Acting user** — ผู้กระทำ
   - **Target record** — เรคคอร์ดเป้าหมาย (เช่น สมาชิกรายหนึ่ง — เห็นทุกเหตุการณ์ที่อ้างถึงเรคคอร์ดนั้น ไม่ว่าใครทำ)
   - **From** / **To** — ช่วงวันที่ (เป็นวันที่ตามเขตเวลาหอการค้า; ถ้าใส่รูปแบบผิดจะขึ้น "Invalid filter")
   - กด **Reset** เพื่อล้างตัวกรอง
3. ตารางแสดงผล **ใหม่สุดอยู่บน** มีคอลัมน์: Time (UTC + เวลาท้องถิ่น) · Event · Actor · Target · Summary · Details
4. มีผลเยอะ → กด **Load older events** ที่ท้ายตารางเพื่อโหลดหน้าถัดไป
5. **Export:** กดปุ่ม **Export CSV** (มุมขวาบน) → ได้ไฟล์ CSV ของ **ชุดที่กรองไว้พอดี** (ไม่รวม cursor หน้าปัจจุบัน — สตรีมทั้งชุด) timestamps เก็บทั้ง UTC และเวลาท้องถิ่น

> 🔴 **Audit log แก้/ลบไม่ได้** — เป็น append-only หน้านี้อ่านอย่างเดียวล้วน ไม่มีทางแก้รายการ
> ℹ️ **manager เห็นได้ แต่ payload บางส่วนถูกปิดบัง (redact)** — ฟิลด์ภายใน (เหตุผล override, staff notes) และ PII ของคนอื่นถูกซ่อนตามสิทธิ์ แต่ **ชื่อผู้กระทำ (Actor) ไม่ถูกซ่อน** ทั้ง admin และ manager เห็น
> ℹ️ การกด Export เองก็ถูกบันทึกลง audit log ด้วย

---

## งานที่ 3 — ดู Timeline ประวัติรวมของสมาชิก

**ใช้เมื่อ:** อยากเข้าใจสมาชิกรายหนึ่งใน 10 วินาที — เห็นทุกเหตุการณ์ในสายเดียว

1. เปิดหน้า **member detail** (`/admin/members/{id}`) → ในการ์ดประวัติกิจกรรม (Recent activity) กด **View all activity** (หรือเข้า `/admin/members/{id}/timeline` ตรง)
2. ระบบรวมทุกแหล่งเป็นสายเดียว เรียงใหม่→เก่า พร้อมไอคอน/ป้ายต่อแหล่ง: **Profile / Audit** · **Invoice** · **Payment** · **Event** · **E-Blast** · **Renewal**
3. ใช้แถบ **Filters** กรอง:
   - **Source** — เลือกแหล่ง (เช่น Invoice อย่างเดียว)
   - **Actor** — Staff / Member / System
   - **From date** / **To date** — ช่วงวันที่
   - กด **Clear filters** เพื่อล้าง
4. ประวัติยาว (1,000+ รายการ) → เลื่อนลงเรื่อยๆ ระบบโหลดเพิ่มทีละหน้า (**Load older activity**) ไม่ค้างหน้าจอ

> ℹ️ **member เห็น timeline ของตัวเองที่ `/portal/timeline`** — สายเดียวกันแต่ฟิลด์ภายในถูกปิดบัง และไม่มีทางเห็นของสมาชิกคนอื่น
> ℹ️ การที่ staff เปิด timeline เต็มของสมาชิกคนอื่น **ถูกบันทึกลง audit** (เป็นการเข้าถึง PII บุคคลที่สาม) — บันทึกครั้งเดียวต่อการเปิดหน้า

---

## งานที่ 4 — ดู Member Benefits (สิทธิประโยชน์ใช้ไปเท่าไหร่)

**ใช้เมื่อ:** อยากรู้ว่าสมาชิกใช้สิทธิประโยชน์คุ้มค่าหรือยัง / จะเตือนให้ใช้

1. เปิดหน้า member detail → กดปุ่ม **Benefits** (มุมขวาบน) หรือเข้า `/admin/members/{id}/benefits`
2. การ์ด **Benefit usage · {ปี}** แสดงต่อสิทธิประโยชน์ที่นับได้:
   - **E-Blasts** และ **Cultural event tickets** — แสดง "{used} of {total} used" + วันที่ใช้ล่าสุด
   - สิทธิประโยชน์ที่ไม่จำกัด/ไม่นับเป็นตัวเลข (เช่น all-employee discount, directory listing) แสดงเป็น **Included benefits** (มี/active) ไม่ใช่โควตา
3. ถ้าสมาชิกใช้น้อยกว่าเกณฑ์ จะมีกล่องเตือน **"You're not using all your benefits"** ("At {x}% of the year you've used {y}% of your benefits") พร้อมลิงก์ให้ใช้สิทธิ
   - เกณฑ์เตือน: (% ปีที่ผ่านไป − % สิทธิที่ใช้เฉลี่ย) ≥ 25 จุด
4. แอ็กชันเฉพาะ staff: ปุ่ม **Send reminder** → เปิดอีเมลถึง primary contact ของสมาชิก (จะมีเฉพาะเมื่อสมาชิกมี primary contact ที่ใช้งานอยู่)

> ℹ️ **ตัวเลขที่ staff เห็น = ตัวเลขเดียวกับที่สมาชิกเห็นที่ `/portal/benefits`** (ต่างแค่ staff มีปุ่ม Send reminder)
> ℹ️ การนับผูกกับ **ปีปฏิทินตามเขตเวลาหอการค้า** — ปีใหม่โควตารีเซ็ต ไม่นับการใช้ปีเก่ามาทับ

---

## งานที่ 5 — Member Directory + สร้าง E-Book (PDF) / JSON

**ใช้เมื่อ:** ค้นทำเนียบสมาชิกภายใน หรือออก **Directory E-Book** ประจำปี / ไฟล์ JSON ให้เว็บไซต์หอการค้าเอาไปใช้

1. ไปที่ **Member directory** (`/admin/directory` — หมวด Membership)
2. ใช้แถบ **Search directory** ค้น:
   - ช่องค้น (ค้นจาก company / industry / description) · ฟิลเตอร์ **Tier** · ติ๊ก **Listed only** (เฉพาะที่เปิดให้แสดง) · กด **Search** / **Clear**
3. ตารางแสดง: Company · Tier · Industry · Location · Listed · Logo · Contact (staff ค้นเห็น **ทุก** สมาชิก ไม่ว่าเปิดแสดงหรือไม่)
4. **สร้าง export** (มุมขวาบน — เป็นงานเบื้องหลัง async):
   - กด **Generate E-Book (PDF)** → คิวงานสร้าง PDF (ขึ้น toast "Generation queued — it will be ready shortly.")
   - กด **Export data (JSON)** → คิวงานสร้าง JSON
5. ดูสถานะที่การ์ด **Recent exports** ด้านล่าง: Type · Status (**Queued** → **Generating…** → **Ready**/**Downloaded** หรือ **Failed**/**Expired**) · Requested
6. เมื่อ Status เป็น **Ready** → กด **Download** (ลิงก์ส่วนตัว ใช้ครั้งเดียว มีหมดอายุ)

> 🔵 **E-Book / JSON มีเฉพาะสมาชิกที่ opt-in (Listed) และเฉพาะฟิลด์ที่เขาเลือกเปิด** เท่านั้น — สมาชิกที่ไม่เปิดแสดงจะไม่ปรากฏในไฟล์ที่เผยแพร่ (แม้ staff จะค้นเห็นในตารางก็ตาม)
> 🔵 ไฟล์ที่สร้างแล้วเป็น "ภาพ ณ เวลานั้น" — ถ้าสมาชิก opt-out ทีหลัง ต้อง **สร้างไฟล์ใหม่** ถึงจะสะท้อนการ opt-out (ไฟล์เก่ายังเป็นของเดิม)
> 🔵 E-Book เรนเดอร์เป็นภาษา default ของ tenant (EN สำหรับ SweCham); ป้ายฟิลด์แปลตามภาษานั้น เนื้อหาที่สมาชิกกรอกแสดงตามที่เขาเขียน

---

## งานที่ 6 — ออก GDPR Data Export ให้สมาชิก (on-behalf)

**ใช้เมื่อ:** มีคำขอ data-subject request — สมาชิกขอสำเนาข้อมูลส่วนตัวทั้งหมด และเราออกให้แทน

1. เปิดหน้า member detail (`/admin/members/{id}`) → เลื่อนไปการ์ด **Data export (GDPR)**
2. กด **Request my data export** → ระบบเริ่มสร้าง archive เบื้องหลัง (อาจใช้ไม่กี่นาที)
3. ดูสถานะที่ตารางใต้ปุ่ม: **Preparing** → **Ready to download** (หรือ **Failed** / **Expired**)
4. เมื่อ **Ready to download** → กด **Download** archive (zip ที่มี profile/contacts/invoices+PDF/events/broadcasts/audit-events ของสมาชิก + README + manifest.json พร้อม checksum)

> 🔴 **การกระทำนี้ถูกบันทึก audit โดยระบุว่า "admin คนนี้เป็นผู้ออก"** (FR-031) — โปร่งใสว่าใครเข้าถึงข้อมูลของใคร
> 🔵 **ลิงก์ดาวน์โหลดหมดอายุใน ~1 ชั่วโมง** หลัง archive พร้อม (เพื่อความปลอดภัย) ถ้าหมดอายุให้กดขอ export ใหม่
> 🔵 สมาชิก **archived** ยัง export ได้ (สิทธิ portability ยังอยู่); สมาชิกที่ใช้สิทธิ **erasure** ไปแล้ว archive จะมีเฉพาะข้อมูลที่เก็บได้ตามกฎหมาย (pseudonymised) — ระบบ **ไม่ฟื้น PII ที่ลบไปแล้ว**

---

## งานที่ 7 — สมาชิกตั้งค่าการแสดงใน Directory (member self-service)

**สถานการณ์:** สมาชิกอยากเลือกว่าจะให้แสดงในทำเนียบหรือไม่ และโชว์ฟิลด์ไหน (แนะนำให้สมาชิกทำเอง)

1. สมาชิกเข้า portal → **Directory listing** (`/portal/profile/directory`)
2. เปิด/ปิดสวิตช์ **List my organisation in the member directory** (ค่าเริ่มต้น = ปิด/private)
3. ใต้ **Fields to show** ติ๊กเลือกฟิลด์ที่จะเปิด: Organisation name · Membership tier · Industry/category · Short description · Website · Logo · Location · Contact name · **Contact email** (ค่าเริ่มต้น = ซ่อน)
4. กรอก **Directory details** (industry/description/website/city/country) แล้วกด **Save**
5. อัปโหลดโลโก้: ส่วน **Logo** → **Upload logo** (PNG/JPEG/WebP ≤2 MB — ระบบ re-encode + ลบ metadata อัตโนมัติ) หรือ **Remove logo**

> 🔵 อีเมลซ่อนโดย default — ถ้าสมาชิกซ่อนอีเมล ไฟล์เผยแพร่จะ **ละ** อีเมล (หรือแทนด้วยตัวบ่งชี้ contact-form)

---

## ❓ คำถามที่พบบ่อย / ข้อควรรู้

| คำถาม | คำตอบ |
|---|---|
| เปิด `/admin` แล้วเห็น roadmap F3–F6 ไม่ใช่แดชบอร์ด? | `FEATURE_F9_DASHBOARD` ยังปิดอยู่ — ต้องเปิดใน Vercel env |
| เปิด `/admin/audit` หรือ `/admin/directory` แล้ว 404? | F9 ปิดอยู่ (หน้าจะ `notFound()` เมื่อ flag off) |
| แอป boot ไม่ขึ้นหลังเปิด F9? | ต้องตั้ง `EXPORT_DOWNLOAD_TOKEN_SECRET` (≥32 ตัว, ไม่ซ้ำ secret อื่น) คู่กับการเปิด flag |
| ตัวเลขบนแดชบอร์ดดูเก่า? | เป็น snapshot รีเฟรชทุก ~5 นาที — ดู "As of {time}"; ฟีด Recent activity ดึงสดไม่ต้องรอ |
| manager เห็นรายได้ไหม? | **เห็น** — F9 เป็นหน้า read-only ทั้ง admin/manager เห็นเงินเหมือนกัน (ต่างจาก F4 ที่ manager แก้ไม่ได้แต่ที่นี่ไม่มีใครแก้ได้อยู่แล้ว) |
| manager เห็น Actor ใน audit ไหม? | **เห็นชื่อผู้กระทำ** (เป็นข้อมูลปฏิบัติการภายใน); แต่ payload PII/ฟิลด์ภายในบางส่วนถูก redact ตามสิทธิ |
| สมาชิกที่ไม่ opt-in โผล่ใน E-Book ไหม? | **ไม่โผล่** — E-Book/JSON มีเฉพาะ Listed + เฉพาะฟิลด์ที่เปิด; staff ยังค้นเห็นในตารางภายใน |
| สมาชิก export ข้อมูลคนอื่นได้ไหม? | **ไม่ได้** — member export ได้เฉพาะของตัวเอง; staff ออกแทนได้ (บันทึก audit ว่า admin เป็นผู้ออก) |
| ลิงก์ดาวน์โหลด export หมดอายุ? | สร้างใหม่ — ลิงก์ใช้ครั้งเดียวและหมดอายุ ~1 ชม. เพื่อความปลอดภัย |
| Engagement score คืออะไร? | คะแนน 0–100 (Healthy/Moderate/Watch/Critical) = ค่ากลับของ at-risk score (F8) แสดง+เรียง+กรองได้ในรายชื่อสมาชิก; เห็นเฉพาะ staff |

---

## 🔴 สิ่งที่ควรระวัง (ไม่ถึงกับย้อนไม่ได้ แต่สำคัญ)

1. **เปิด `FEATURE_F9_DASHBOARD` โดยลืมตั้ง `EXPORT_DOWNLOAD_TOKEN_SECRET`** → แอป boot ไม่ขึ้น (ต้องตั้งคู่กันเสมอ)
2. **Audit log** เป็น append-only — แก้/ลบไม่ได้ตลอดกาล (โดยตั้งใจเพื่อ compliance)
3. **GDPR export on-behalf** ถูกบันทึกชื่อ admin ผู้ออกลง audit — เป็นการเข้าถึง PII ที่ตรวจสอบย้อนได้
4. **ลิงก์ดาวน์โหลด E-Book / GDPR archive ใช้ครั้งเดียวและหมดอายุ** — อย่าแชร์ต่อ; หมดแล้วสร้าง/ขอใหม่
