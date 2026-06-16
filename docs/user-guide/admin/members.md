# คู่มือ: จัดการสมาชิก + ผู้ติดต่อ + เชิญเข้าระบบ (F3)

> **ใครใช้:** เจ้าหน้าที่สิทธิ์ **admin** (สร้าง/แก้/archive/เชิญ/bulk ได้) · **manager** ดู+ค้นหาอย่างเดียว (แก้ไม่ได้) · **member** เห็นเฉพาะบริษัทตัวเองที่ `/portal`
> **เมนู:** Members (`/admin/members`) · รายละเอียดสมาชิก (`/admin/members/:id`) · Timeline (`/admin/members/:id/timeline`)
> **UAT ของ flow นี้:** [../../uat/admin/members.uat.md](../../uat/admin/members.uat.md)

---

## ⚠️ ก่อนเริ่ม — สิ่งที่ต้องมี

1. **ต้องมีแพ็กเกจสมาชิก (plan) ที่ active สำหรับปีปัจจุบันก่อน** (F2 — Settings → Plans) ไม่งั้นหน้า **Add member** จะขึ้น "No active plans found — create a plan first." และสร้างสมาชิกไม่ได้
2. ล็อกอินด้วยบัญชีที่ถูกต้อง:
   - ปุ่มสร้าง/แก้/archive/bulk จะแสดง **เฉพาะ admin**
   - manager จะเห็นแถบ "Read-only view…" และไม่มีปุ่มแก้ไขใดๆ
3. การ **เชิญผู้ติดต่อเข้าพอร์ทัล** ใช้ flow เชิญของ F1 (ส่งอีเมล token อายุ 7 วัน) — ผู้ติดต่อต้องมี **email** และยังไม่ผูกบัญชีพอร์ทัล
4. กฎ `tax_id` (เลขผู้เสียภาษี): **บังคับ** สำหรับทุก Corporate tier (Premium / Large / Regular / Start-up) และทุก Partnership tier; **ไม่บังคับ** สำหรับ Individual / Thai Alumni — ถ้า `country = TH` ต้องเป็นเลข **13 หลักผ่าน checksum** ของไทย
5. F8 (at-risk / engagement) และ F9 (benefits / data export) อยู่หลัง feature flag — บางคอลัมน์/ส่วนจะซ่อนถ้า flag ปิด

---

## ภาพรวมแนวคิดหลัก (จำให้แม่น)

- **Member = บริษัท** (นิติบุคคล) ไม่ใช่บุคคล — แต่ละบริษัทมี **ผู้ติดต่อ (Contact) หลายคน** และต้องมี **Primary contact 1 คนเสมอ** (DB บังคับ unique 1 คน/บริษัท)
- **Member number** = เลขสมาชิกอ่านง่ายต่อหอการค้า เช่น `SCCM-0042` (prefix ต่อ tenant) — แสดงในตาราง, หน้ารายละเอียด, และ PDF ภาษีของ F4

### สถานะสมาชิก (Member status)

```
[Active] ──Archive──► [Archived]  (ซ่อนจาก directory · เพิกถอน session พอร์ทัล)
 ปกติ        │            │
 │           │            └── Restore (ภายใน 90 วันเท่านั้น) ──► [Active]
 │
 └── สลับ inline ◄──► [Inactive]  (ยังเห็นใน directory · ไม่ archive)

หมายเหตุ:
- Active / Inactive สลับกันได้อิสระ (inline toggle ในตาราง)
- Archived = soft-delete: ซ่อนจาก default view, ตัด session พอร์ทัลของผู้ใช้ที่ผูกไว้
- Restore ได้ภายใน 90 วันนับจาก archived_at; เกิน 90 วันปุ่ม Restore จะ disable
- ไม่มีปุ่ม "ลบถาวร" ใน UI — ต้องใช้ DB action (กันข้อมูลหาย)
```

> 🔴 **กฎเหล็ก:** การแก้ **email ของ Primary contact ที่ผูกบัญชีพอร์ทัลแล้ว** เป็นการกระทำที่มีผลด้านความปลอดภัยสูง — ตัด session ทันที + ต้องยืนยันอีเมลใหม่ + ส่ง token "ไม่ใช่ฉัน" ไปอีเมลเก่า (ดูงานที่ 6) ทำผ่าน **ฟอร์ม Edit สมาชิก (member edit)** เท่านั้น (ฟอร์มนั้นเป็นตัว commit การเปลี่ยน email พร้อม kill-session + dual-channel) — *ไม่ใช่* กล่อง Edit contact ธรรมดา (ซึ่งจงใจล็อกช่อง email ไว้)

---

## งานที่ 1 — สร้างสมาชิกใหม่ + Primary contact

**สถานการณ์:** เพิ่มบริษัทสมาชิกใหม่เข้าระบบพร้อมผู้ติดต่อหลัก

1. ไปที่ **Members** → กดปุ่ม **"Add member"** (มุมขวาบน) — หรือเปิด **command palette (Cmd/Ctrl+K)** แล้วพิมพ์ "new member" / "create member"
2. กรอกส่วน **Company**:
   - **Company name** * (บังคับ)
   - **Country (ISO code)** * — รหัส 2 ตัว เช่น `TH`, `SE`, `US`
   - **Legal entity type** — ข้อความอิสระ เช่น "บริษัทจำกัด", "AB", "Ltd"
   - **Tax ID** — บังคับตาม tier (ดู § ก่อนเริ่ม ข้อ 4); `TH` ต้อง 13 หลัก
   - **Website**, **Founded year**, **Annual turnover (THB)**, **Description**
3. กรอกส่วน **Address** (ที่อยู่) ตามต้องการ
4. เลือก **Plan** * และ **Plan year** — ถ้าเป็นแพ็กเกจ Individual (เช่น **Thai Alumni**) ฟอร์มจะขอ **Date of birth** เพิ่ม
5. กรอกส่วน **Primary contact**:
   - **First name** *, **Last name** *, **Email** *, **Phone**, **Role / title**, **Preferred language** (en/th/sv)
6. (ถ้าจำเป็น) ใส่ **Notes (admin only)** — เห็นเฉพาะเจ้าหน้าที่ ไม่แสดงให้สมาชิก และ **ไม่อยู่ใน search index**
7. กด **"Create member"**
   - ระบบบันทึกสมาชิกสถานะ **Active**, ผู้ติดต่อเป็น **Primary**, flag ค่าแรกเข้า (registration fee) ให้สมาชิกใหม่อัตโนมัติ, เขียน audit `member_created`
   - กลับเข้าหน้ารายละเอียดสมาชิกใหม่

### กรณีค่าผิดกฎ plan (turnover / อายุ / Start-up อายุบริษัท)

- ถ้า **turnover ไม่เข้าเกณฑ์ plan** / **อายุเกิน 35 (Thai Alumni)** / **บริษัทเกิน 2 ปี (Start-up)** ระบบจะ **เตือน (warning) ไม่บล็อกทันที** แต่บันทึกไม่ผ่านจนกว่าจะระบุเหตุผล override
- กล่อง **"Reason for bypassing validation"** จะให้เลือก **Reason** (Board approved / Pending renewal (grace period) / Data correction / **Other**) + **Note** — ถ้าเลือก **Other** ต้องกรอก Note (ไม่เกิน 500 ตัวอักษร)
- กด **"Proceed with override"** เพื่อบันทึกพร้อมเหตุผล (เก็บใน audit log) หรือ **"Cancel"**

### กรณีชื่อบริษัทซ้ำ (soft-dedupe)

- ถ้ามีบริษัท **ชื่อ + ประเทศเดียวกัน** อยู่แล้ว ระบบขึ้นกล่อง **"Possible duplicate found"** แสดงสมาชิกเดิม
- เลือก **"Open existing member"** (ไปดูตัวเดิม) · **"Proceed anyway"** (สร้างเป็นรายการใหม่) · **"Cancel"** — *ไม่บล็อก* การสร้าง

---

## งานที่ 2 — ค้นหา / กรอง / เปิดรายละเอียดสมาชิก

**สถานการณ์:** หาบริษัทสมาชิกอย่างรวดเร็ว

1. ที่ **Members** ใช้ช่องค้นหา **"Search by company, contact name, email, or member number"** — พิมพ์บางส่วนของชื่อบริษัท / ชื่อผู้ติดต่อ / อีเมล (case-insensitive) ผลลัพธ์แคบลงทันที
2. ใช้ฟิลเตอร์:
   - **Status** — Active / Inactive / **Archived** (เลือก Archived เพื่อดูที่ archive ไว้; ค่า default คือ Active+Inactive)
   - **Plan** — เลือกแพ็กเกจ
   - **Risk band** — Healthy / Warning / At-risk / Critical (มาจาก F8 — ถ้ายังไม่คำนวณจะขึ้น "—")
   - ฟิลเตอร์สะท้อนใน URL → **bookmark/แชร์ลิงก์ได้**
3. กด **"Clear filters"** เพื่อล้างฟิลเตอร์
4. คลิกที่ **แถว** เพื่อเปิดหน้ารายละเอียด (`/admin/members/:id`) — เห็น Company, Membership, Contacts (Primary/Other), Renewal & Health, Timeline preview
5. หรือใช้ **command palette (Cmd/Ctrl+K)** พิมพ์ชื่อบริษัทเพื่อลิงก์ตรงเข้าหน้ารายละเอียด

> ℹ️ คอลัมน์ **Member No.** และ **Engagement** เรียงลำดับได้ (กดหัวคอลัมน์)
> ℹ️ ในหน้ารายละเอียด ปุ่ม copy (📋) อยู่ที่ **Email**, **Tax ID**, และ **Member ID** (ใน Technical)

---

## งานที่ 3 — แก้ไขสมาชิก / เปลี่ยน plan / จัดการผู้ติดต่อ

**สถานการณ์:** อัปเดตข้อมูลบริษัท เปลี่ยนแพ็กเกจ หรือดูแลผู้ติดต่อ

1. เปิดหน้ารายละเอียดสมาชิก → กด **"Edit"** (ขวาบน)
2. แก้ข้อมูล Company / Plan / Primary contact ในฟอร์ม → กด **"Save changes"**
   - เปลี่ยน plan ข้าม tier ได้ ถ้า turnover/อายุ/อายุบริษัทไม่เข้าเกณฑ์ใหม่จะขึ้น **override dialog** เหมือนตอนสร้าง (งานที่ 1)
   - เปลี่ยน **plan ของ Partnership** ที่ทำให้ bundled corporate tier เปลี่ยน → ขึ้นกล่อง **"Plan bundle change"** บอก **จำนวนสมาชิกจริง** ที่ได้รับผลกระทบ → กด **"Confirm bundle change"** หรือ **"Cancel"**
3. **จัดการผู้ติดต่อ** ทำได้ที่หน้ารายละเอียด (ในการ์ด Contacts):
   - **เพิ่ม:** กด **"Add contact"** → กรอกแล้ว Save → เพิ่มเป็น **Secondary contact**
   - **แก้:** เมนูจุดของผู้ติดต่อ → **"Edit"** (แก้ชื่อ/โทร/role/ภาษา ได้)
   - **ตั้งเป็นหลัก:** **"Make primary"** → คนเดิมที่เป็น Primary จะถูกลดเป็น Secondary อัตโนมัติ (audit `member_primary_contact_changed`)
   - **ลบ:** **"Remove"** (ยืนยันในกล่อง) — *ลบ Primary คนเดียวที่เหลือไม่ได้* ต้องตั้งคนอื่นเป็น Primary ก่อน

> ℹ️ **เปลี่ยน email ของผู้ติดต่อ:** กล่อง **Edit contact จงใจล็อกช่อง email** ของผู้ติดต่อที่ผูกบัญชีพอร์ทัล (ขึ้นโน้ต "To change this contact's email, use the portal invitation flow." — ข้อความนี้ในแอปกำลังจะปรับ) — วิธีเปลี่ยน email จริงคือใช้ **ฟอร์ม Edit สมาชิก (member edit)** ซึ่งเป็นตัว commit การเปลี่ยน email (รัน kill-session + dual-channel) ไม่ใช่ flow เชิญพอร์ทัล (เหตุผลความปลอดภัย ดูงานที่ 6)
> ℹ️ **โอน Primary contact ฉุกเฉิน** (คนเดิมลาออก): ใช้ **"Add contact"** เพิ่มคนใหม่ → **"Make primary"** บนแถวคนใหม่ (มีปุ่ม ❓ ช่วยอธิบายขั้นตอนนี้ที่หัวการ์ด Contacts)

---

## งานที่ 4 — เชิญผู้ติดต่อเข้าพอร์ทัลสมาชิก

**สถานการณ์:** ให้ผู้ติดต่อล็อกอินดูข้อมูลบริษัทตัวเองที่ `/portal`

1. เปิดหน้ารายละเอียดสมาชิก → ที่แถวผู้ติดต่อที่มี **email** และยังไม่ผูกบัญชี กด **"Invite to portal"**
2. ระบบส่งอีเมลเชิญ (F1 invite, token 7 วัน) scoped กับ member นี้ + role `member` → ขึ้น toast **"Invitation sent."**
3. ระหว่างรอ ผู้ติดต่อจะมี badge **"Expires in N days"** (คำเชิญค้าง) จนกว่าจะรับเชิญ → เปลี่ยนเป็น badge **"Portal linked"**

### ถ้าอีเมลเชิญตีกลับ (bounce)

- ผู้ติดต่อจะมี badge **"Invite bounced"** และแถวสมาชิกใน directory มีสัญญาณเตือน
- กด **"Re-send invite"** เพื่อส่งคำเชิญใหม่ + เคลียร์ flag bounce

---

## งานที่ 5 — แก้ทีละช่อง (inline) + ทำเป็นชุด (bulk)

### 5.1 สลับสถานะ inline (เฉพาะ admin)

- ในตาราง Members คอลัมน์ **Status** เป็นปุ่มสลับ — **คลิก** ที่ badge เพื่อสลับ **Active ↔ Inactive**
- บันทึกทันที (optimistic) + toast **"Status updated"**; ถ้า server error จะ **ย้อนค่ากลับ** + toast "Save failed. Reverted."
- แถวที่ **Archived สลับ inline ไม่ได้** (แสดงเป็น badge เฉยๆ)

### 5.2 Bulk action (เลือกหลายแถว)

1. ติ๊ก checkbox หน้าแถว (Shift+Click เลือกช่วง · Ctrl/Cmd+Click เพิ่มทีละแถว) → แถบ **Bulk actions** โผล่ด้านล่าง พร้อมตัวนับ **"N selected"**
2. เลือกการกระทำ:
   - **"Archive"** → กล่องยืนยันลิสต์ชื่อบริษัท (ตัด "…and N more" ถ้าเกิน 5) + ต้อง **พิมพ์วลียืนยัน** "Archive N members" → archive ทั้งชุด (all-or-nothing)
   - **"Send invite"** → กล่องยืนยัน → ส่งคำเชิญพอร์ทัลให้ที่เลือก (สรุปเป็น queued / skipped / failed)
3. **"Clear selection"** ล้างการเลือก

> 🔴 **เพดาน 100 แถว/ชุด:** เลือกเกิน 100 ปุ่มจะ disable + ขึ้น "Maximum 100 members per batch. Split the selection." (server ก็ปฏิเสธชุด >100 ด้วย)
> ℹ️ มี rate limit: **≤ 10 bulk operations / 10 นาที / admin** — เกินจะขึ้น "Too many bulk actions. Wait a few minutes and try again." (429)
> ⚠️ ปุ่ม **"Change plan"** แบบ bulk **ยังไม่เปิดใช้งานใน UI** (มีเฉพาะ Archive + Send invite) — เปลี่ยน plan ให้ทำทีละรายผ่านงานที่ 3

---

## งานที่ 6 — เปลี่ยน email ของผู้ติดต่อที่ผูกพอร์ทัล (กระทำพิเศษ)

**ใช้เมื่อ:** ต้องเปลี่ยน email ของผู้ติดต่อที่มีบัญชีพอร์ทัลอยู่แล้ว

- ทำผ่าน **ฟอร์ม Edit สมาชิก (member edit)** เท่านั้น (ไม่ใช่กล่อง Edit contact ทั่วไป ซึ่งล็อกช่อง email ไว้) เพราะมีผลกับการล็อกอิน — แก้ช่อง email ของ Primary contact ในฟอร์ม Edit สมาชิกแล้ว Save
- เมื่อเปลี่ยน ระบบทำใน **ธุรกรรมเดียว**: อัปเดต email ผู้ติดต่อ + บัญชี F1, **ตัด session ทั้งหมดของผู้ใช้นั้นทันที**, ปิด email เก่าไม่ให้ล็อกอิน, ส่ง **token ยืนยัน email ใหม่** (อายุ 24 ชม. ใช้ได้หลังหน่วง 5 นาที), และส่ง **token "ไม่ใช่ฉัน — revert + freeze"** ไปอีเมลเก่า (อายุ 48 ชม.)
- email ใหม่ **ล็อกอินไม่ได้จนกว่าจะยืนยัน token**
- ถ้าอีเมลยืนยันส่งไม่สำเร็จถาวร → การ **ส่งอีเมลยืนยันซ้ำ (FR-012c)** ยังเป็น **API-only** ตอนนี้ (มี endpoint `POST /api/members/:memberId/contacts/:contactId/resend-verification` แต่ **ยังไม่มีปุ่ม/UI** บนหน้ารายละเอียดสมาชิก) — ออก token ใหม่ได้ผ่าน API โดยตรง (ไม่ต้องพึ่ง DB operator)

> 🔴 ผู้ถืออีเมลเก่าคลิก token "ไม่ใช่ฉัน" ภายใน 48 ชม. = **ย้อนการเปลี่ยน email ทั้งหมด** + บังคับ reset password ของบัญชีนั้น (กัน admin ที่ถูกแฮ็กยึดบัญชีสมาชิก)

---

## งานที่ 7 — Archive (soft-delete) และ Restore สมาชิก

**ใช้เมื่อ:** สมาชิกเลิก/ไม่ต่ออายุ — เก็บประวัติไว้แทนการลบ

1. เปิดหน้ารายละเอียดสมาชิก (Active) → กด **"Archive member"**
2. ในกล่อง **"Archive {company}?"** ใส่ **Reason (optional)** (≤ 500 ตัวอักษร เห็นใน audit) → กด **"Archive"**
   - สถานะเป็น **Archived**, ตั้ง `archived_at`, ตัด session พอร์ทัลของผู้ใช้ที่ผูก, ซ่อนออกจาก default directory, เขียน audit `member_archived`
3. **ดูที่ archive ไว้:** ที่ Members เลือกฟิลเตอร์ **Status → Archived**
4. **คืนสภาพ:** ในแบนเนอร์ "Archived on {date}" กด **"Restore"** → กลับเป็น **Active**, เคลียร์ `archived_at`, audit `member_undeleted`
   - แบนเนอร์บอก "N days remaining" ในหน้าต่าง 90 วัน
   - **เกิน 90 วัน:** ปุ่ม **"Restore"** disable + tooltip "Archived > 90 days — contact a system admin to restore" (ข้อมูลยังอ่านได้)

> 🔴 archive แล้วผู้ใช้พอร์ทัลที่ผูกไว้ **ล็อกอิน `/portal` ไม่ได้** (403 "account inactive" — ไม่บอกเหตุผลเชิงลึก)

---

## งานที่ 8 — Timeline ของสมาชิก

1. เปิดหน้ารายละเอียด → ดู preview 3 รายการล่าสุด หรือกด **"View all activity"** → ไปหน้า **Timeline** (`/admin/members/:id/timeline`)
2. เห็นเหตุการณ์เรียง **ใหม่สุดก่อน**: สร้าง/แก้/เปลี่ยน plan/เปลี่ยน Primary/เปลี่ยนสถานะ/เชิญ/override ฯลฯ พร้อมเวลา (ค.ศ. เก็บ, แสดง พ.ศ. สำหรับ th-TH), ชื่อผู้กระทำ (หรือ "System")
3. กรองด้วย source / actor / ช่วงวันที่; โหลดเพิ่มทีละ 50 ด้วย **"Load older events"**

> ℹ️ member ที่เปิด timeline ตัวเองจะเห็นเฉพาะ event ของตัวเอง และ field ภายใน (override reason, internal notes) จะถูก redact

---

## สิ่งที่สมาชิก (member) ทำได้เองที่ `/portal`

F3 เปิดให้ member ทำเองเพียง 3 อย่าง (ส่วนที่พึ่ง F4/F5/F6/F7 จะ **ซ่อนทั้งหมด** ไม่ขึ้น "coming soon"):

> ℹ️ **โครงสร้างหน้า:** `/portal` เองคือ **Dashboard** (หน้าสรุปภาพรวม) — *ไม่ใช่* หน้า Profile; **company Profile อยู่ที่ `/portal/profile`** (ดูข้อมูลบริษัท), แก้ที่ `/portal/edit`, เชิญเพื่อนร่วมงานที่ `/portal/contacts/invite`

| เมนู | ทำอะไร | หมายเหตุ |
|---|---|---|
| **Profile** (`/portal/profile`) | ดูข้อมูลบริษัท + plan + ผู้ติดต่อของตัวเอง | เห็นเฉพาะบริษัทตัวเอง |
| **Edit Profile** (`/portal/edit`) | แก้เฉพาะ whitelist: First/Last name, Phone, Preferred Language, Website, Description | field อื่น (plan/turnover/status/tax_id/email) admin เท่านั้น — ถ้า forge payload จะถูกปฏิเสธ 403 |
| **Invite Colleague** (`/portal/contacts/invite`) | เชิญเพื่อนร่วมงานเป็น Secondary contact | **เฉพาะ Primary contact** เท่านั้น (คนอื่นขึ้น "Only the primary contact can invite colleagues.") |

---

## ❓ คำถามที่พบบ่อย / ข้อควรรู้

| คำถาม | คำตอบ |
|---|---|
| manager แก้สมาชิกได้ไหม? | ไม่ได้ — อ่าน+ค้นหาอย่างเดียว (เห็นแถบ "Read-only view…"); URL ตรงไปหน้า new/edit จะได้ 404 |
| สมาชิกไม่มี tax_id สร้างได้ไหม? | ได้เฉพาะ tier Individual / Thai Alumni; Corporate/Partnership บังคับ tax_id |
| ทำไมคอลัมน์ Risk ขึ้น "—"? | คะแนน at-risk มาจาก F8 — ถ้ายังไม่คำนวณ (สมาชิกใหม่ <30 วัน หรือ flag ปิด) จะขึ้น placeholder ไม่ใช่ข้อมูลปลอม |
| ลบสมาชิกถาวรได้ไหม? | ไม่ได้จาก UI — มีแค่ Archive (soft-delete) + Restore 90 วัน; ลบถาวรต้อง DB action (กันข้อมูลหาย) |
| Restore เกิน 90 วันทำยังไง? | ปุ่ม disable — ติดต่อ system admin (platform-admin tooling, F13) |
| เปลี่ยน email ผู้ติดต่อในกล่อง Edit contact ไม่ได้? | ถูกแล้ว — กล่อง Edit contact จงใจล็อกช่อง email ของผู้ติดต่อที่ผูกพอร์ทัลด้วยเหตุผลความปลอดภัย; ให้เปลี่ยน email ผ่าน **ฟอร์ม Edit สมาชิก (member edit)** แทน ซึ่งจะรัน kill-session + dual-channel ให้ (งานที่ 6) |
| bulk เลือกเกิน 100 แถว? | ปุ่ม disable + ข้อความให้แบ่งชุด; server ก็ปฏิเสธ |
| วันที่แสดงเป็น พ.ศ. หรือ ค.ศ.? | เก็บเป็น ค.ศ. (สากล) เสมอ; th-TH แสดงเป็น พ.ศ. (display-only) |

---

## 🔴 สรุปสิ่งที่ "ย้อนกลับ/แก้ยาก" (ระวังให้มาก)

1. **เปลี่ยน email ของผู้ติดต่อที่ผูกพอร์ทัล** → ตัด session ทันที + email เก่าล็อกอินไม่ได้ทันที (ต้องยืนยัน token ใหม่; ผู้ถืออีเมลเก่ามี 48 ชม. revert)
2. **Make primary** → คนเดิมถูกลดเป็น Secondary ทันที
3. **Remove contact** → soft-delete (เก็บ audit แต่หายจาก directory); ลบ Primary คนสุดท้ายไม่ได้
4. **Archive** → ตัด session พอร์ทัลของผู้ผูก + Restore ได้ภายใน 90 วันเท่านั้น
5. **ไม่มีลบถาวรใน UI** — ออกแบบให้กันข้อมูลหาย
