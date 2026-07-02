# UAT: จัดการสมาชิก + ผู้ติดต่อ + เชิญเข้าระบบ (F3)

> **คู่มือ flow นี้:** [../../user-guide/admin/members.md](../../user-guide/admin/members.md)
> **ที่มา:** `specs/005-members-contacts/spec.md` (US1–US7) + Acceptance Scenarios + Success Criteria + FR
> **รันบน:** preview deploy (ไม่ใช่ production) · บัญชี: admin, manager, member

## ก่อนเริ่ม (Preconditions รวม)
- [ ] มีแพ็กเกจ (plan) ปีปัจจุบัน **active** อย่างน้อย 1 รายการ (มี Corporate + Partnership + Individual/Thai Alumni หากต้องทดสอบกฎ tier)
- [ ] มีบริษัทสมาชิกทดสอบเดิมอย่างน้อย 1 ราย (สำหรับ edit/archive/timeline) — แนะนำ ~10+ รายเพื่อทดสอบ search/filter
- [ ] มีบัญชี **admin**, **manager**, และ **member** (ผูกกับสมาชิกทดสอบ) สำหรับเทสต์สิทธิ์
- [ ] เข้าถึงกล่องอีเมลทดสอบได้ (สำหรับ invite / email-change / revert token)
- [ ] ทราบสถานะ feature flag F8 (risk) / F9 (benefits, data export) บน preview

**วิธีกรอก:** แต่ละ TC ทำเครื่องหมายในช่อง "ผล" (☐ ผ่าน หรือ ☐ ไม่ผ่าน) + ใส่หลักฐาน (member number/ภาพหน้าจอ/เลข audit) ในช่อง "หมายเหตุ"

---

## TC-MBR-01 — สร้างสมาชิกใหม่ + Primary contact
**อ้างอิง:** US1-AS1, FR-002, SC-001 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | Members → **Add member** | ฟอร์มเปิด มีส่วน Company / Address / Plan / Primary contact; มีโน้ต "* fields are required" |
| 2 | กรอก Company name, Country=`SE`, Plan (Corporate ปีนี้), Primary contact (First/Last/Email) | ฟิลด์บังคับมี asterisk + `aria-required` |
| 3 | กด **Create member** | สมาชิกถูกบันทึก **Active**, ผู้ติดต่อเป็น **Primary**, ค่าแรกเข้า flag ให้สมาชิกใหม่, toast "Member created." |
| 4 | เปิดหน้ารายละเอียดที่ได้ | เห็น Company + Primary contact + **Member No.** (เช่น `SCCM-00xx`); Timeline มี event `member_created` |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ (member no./หลักฐาน):** ____________________

---

## TC-MBR-02 — เตือน turnover ไม่เข้าเกณฑ์ plan + override
**อ้างอิง:** US1-AS2, FR-006, FR-006a · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | สร้างสมาชิกเลือก plan ที่ต้องการ turnover สูง (เช่น Premium) แต่ใส่ turnover ต่ำกว่าเกณฑ์ | ขึ้น warning ว่า turnover ไม่เข้าเกณฑ์ plan; save ไม่ผ่านจนกว่าจะ override |
| 2 | กล่อง "Reason for bypassing validation" เลือก Reason = **Other** แต่เว้น Note | บล็อก: "Note is required when reason is \"Other\"." |
| 3 | ใส่ Note แล้วกด **Proceed with override** | บันทึกสำเร็จ (event `member_created`). **หมายเหตุ:** ปัจจุบัน create-member ยัง**ไม่บันทึก** override reason (code+note) ลง audit payload ของ `member_created` — reason ถูก validate แต่ยังไม่ persist (ต่างจาก change-plan ที่บันทึก); อย่า fail เพราะไม่พบ reason ใน audit ของ create |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MBR-03 — เตือน Thai Alumni อายุเกิน 35 / Start-up บริษัทเกิน 2 ปี
**อ้างอิง:** US1-AS3, US1-AS4, FR-007, FR-008 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เลือก plan **Thai Alumni**, ใส่ Date of birth ที่ทำให้อายุ > 35 ณ วันเริ่ม plan | warning เรื่องอายุ; save ต้อง override + เหตุผล (validate ใน dialog — ยังไม่ persist ลง audit ของ create, ดู TC-02) |
| 2 | เลือก plan **Start-up**, ใส่ Founded year ที่ทำให้บริษัทอายุ > 2 ปี | warning เรื่องอายุบริษัท; save ต้อง override + เหตุผล |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MBR-04 — กฎ tax_id: format TH 13 หลัก (tax_id ไม่บังคับตาม tier — บางสมาชิกไม่มี)
**อ้างอิง:** FR-009a · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | สร้างสมาชิก Corporate/Partnership แต่เว้น **Tax ID** | save ผ่านได้ — tax_id **ไม่บังคับตาม tier** (โดยตั้งใจ: บางสมาชิกไม่มี tax_id); ระบบตรวจเฉพาะ *format* (TH 13 หลัก/checksum) เมื่อมีการกรอกเท่านั้น |
| 2 | ตั้ง Country=`TH` ใส่ tax_id ที่ไม่ใช่ 13 หลัก/checksum ผิด | ถูกปฏิเสธด้วยข้อความ format ไทย |
| 3 | สร้างสมาชิก **Individual / Thai Alumni** เว้น Tax ID | save ผ่านได้ (ไม่บังคับ) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MBR-05 — soft-dedupe เตือนชื่อบริษัทซ้ำ (ไม่บล็อก)
**อ้างอิง:** FR-031, Edge: Duplicate company · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | สร้างสมาชิกชื่อ + ประเทศ ตรงกับรายที่มีอยู่ → กด Create | ขึ้นกล่อง "Possible duplicate found" แสดงสมาชิกเดิม (ชื่อบริษัท + ลิงก์ "Open existing member") |
| 2 | กด **Proceed anyway** | สร้างเป็นรายการใหม่ที่แยกกัน (ไม่บล็อก) |
| 3 | (ทำซ้ำ) กด **Open existing member** | นำไปหน้าสมาชิกเดิมแทน ไม่สร้างใหม่ |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MBR-06 — สร้างสมาชิกจาก command palette
**อ้างอิง:** US1-AS6, FR-017 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | กด Cmd/Ctrl+K → พิมพ์ "new member" หรือ "create member" | ปรากฏ action สร้างสมาชิกเป็นตัวเลือกบนสุด |
| 2 | เลือก action | นำไปหน้า Add member |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MBR-07 — ค้นหาแบบ substring (company/contact/email)
**อ้างอิง:** US2-AS1, FR-016, SC-002 · **บทบาท:** admin หรือ manager

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | พิมพ์บางส่วนของชื่อบริษัทในช่อง "Search by company, contact name, email, or member number" | ผลลัพธ์แคบลงตาม company/contact name/email (case-insensitive) ภายใน ~500 ms |
| 2 | ค้นด้วย **member number** เต็ม (เช่น `SCCM-0001`, `0001`, หรือ `1`) | match แบบ **exact** ตามเลขสมาชิก (member number เป็น exact-match ไม่ใช่ substring — เศษตัวเลขบางส่วนจะไม่ match) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MBR-08 — ฟิลเตอร์ + URL bookmark ได้
**อ้างอิง:** US2-AS2, FR-001 · **บทบาท:** admin หรือ manager

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เลือก Status=Active + Plan=(เลือกหนึ่ง) | เห็นเฉพาะที่ตรงทุกฟิลเตอร์ |
| 2 | ดู URL → copy แล้วเปิดแท็บใหม่ | สถานะฟิลเตอร์ถูก restore จาก URL |
| 3 | กด **Clear filters** | ฟิลเตอร์ถูกล้าง กลับ default (Active+Inactive) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MBR-09 — เปิดหน้ารายละเอียด + copy-to-clipboard
**อ้างอิง:** US2-AS3, FR-030 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | คลิกแถวสมาชิก | โหลด `/admin/members/:id` แสดง Company / Membership / Contacts (Primary+Other) / Renewal & Health / Timeline preview |
| 2 | กดปุ่ม copy ที่ Email และ Tax ID และ Member ID (ใน Technical) | คัดลอกค่า + toast "Copied!" |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MBR-10 — คอลัมน์ Risk เป็น placeholder ปลอดภัย (F8)
**อ้างอิง:** US2-AS5 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ดูคอลัมน์ Risk/Engagement ของสมาชิกที่ยังไม่ถูกคำนวณ | ขึ้น "—" (neutral placeholder) ไม่ throw, ไม่แสดงข้อมูลปลอม (ปัจจุบัน cell ยัง**ไม่มี tooltip** อธิบาย 30 วัน — string `riskNotComputedTooltip` มีใน en.json แต่ยังไม่ wire เข้า cell) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MBR-11 — แก้สมาชิก + เปลี่ยน plan ข้าม tier (downgrade ไม่เตือน)
**อ้างอิง:** US3-AS1, FR-004 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิดสมาชิก Premium (turnover เข้าเกณฑ์ Regular) → **Edit** → เปลี่ยน plan เป็น Regular Corporate → **Save changes** | save ผ่านโดยไม่มี warning (downgrade ถูกต้องตาม plan ใหม่); toast "Member updated." |
| 2 | ดู Timeline | มี event `member_plan_changed` (old→new plan) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MBR-12 — ตั้ง Secondary เป็น Primary (auto-demote)
**อ้างอิง:** US3-AS2, FR-003, FR-011 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | สมาชิกที่มี ≥2 ผู้ติดต่อ → เมนูจุดของ Secondary → **Make primary** → ยืนยัน | คนใหม่เป็น Primary, คนเดิมถูกลดเป็น Secondary อัตโนมัติ; toast "Primary contact updated." |
| 2 | รีเฟรช | มี Primary เพียง 1 คน; Timeline มี `member_primary_contact_changed` |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MBR-13 — ลบ Primary คนสุดท้ายไม่ได้
**อ้างอิง:** US3-AS3, Edge: Member without any contacts · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | สมาชิกที่มี Primary + Secondary → ลอง **Remove** ตัว Primary | ถูกบล็อก: "Cannot remove the primary contact. Promote another contact first." (หรือเทียบเท่า) |
| 2 | ตั้ง Secondary เป็น Primary ก่อน แล้วค่อย Remove คนเดิม | Remove สำเร็จ (มี Primary เหลือเสมอ) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MBR-14 — เพิ่ม + แก้ Secondary contact
**อ้างอิง:** US3 (Independent Test), FR-011 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | หน้ารายละเอียด → **Add contact** → กรอกแล้ว Save | เพิ่มเป็น Secondary; toast "Contact added." |
| 2 | เมนูจุด → **Edit** แก้ Phone/Role/ภาษา → Save | toast "Contact updated."; ค่าอัปเดต |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MBR-15 — Bundle-change warning แสดง member count จริง
**อ้างอิง:** US3-AS4, US3-AS5, FR-010, SC-008 · **บทบาท:** admin · **เงื่อนไข:** มี Partnership plan ที่ `includes_corporate_plan_id`

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | Edit สมาชิก Partnership ให้ bundled corporate tier เปลี่ยน → **Save changes** | ขึ้นกล่อง "Plan bundle change" บอก **จำนวนสมาชิกจริง** (old bundle vs new bundle) |
| 2 | กด **Cancel** | ไม่มี PATCH; ฟอร์มยังอยู่ในสถานะ draft |
| 3 | ทำซ้ำแล้วกด **Confirm bundle change** | PATCH ยิง + audit `plan_bundle_changed` อ้างจำนวนสมาชิก ณ เวลายืนยัน |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MBR-16 — แก้ email ผ่าน Edit contact ถูกปฏิเสธ (security)
**อ้างอิง:** US3-AS6 (entry guard), FR-012a · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ผู้ติดต่อที่ผูกบัญชีพอร์ทัล → **Edit** มองหาช่อง email | ช่อง email แก้ไม่ได้ + โน้ต "To change this contact's email, edit it on the member Edit page. An unlinked contact must be invited to the portal first." |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MBR-17 — เปลี่ยน email ที่ผูกพอร์ทัล: ตัด session + ยืนยันใหม่ + dual-channel
**อ้างอิง:** US3-AS6, FR-012a · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ผ่าน flow เปลี่ยน email พอร์ทัล เปลี่ยน email ของผู้ติดต่อที่มีบัญชี F1 | ใน 1 ธุรกรรม: อัปเดต contact+user email, **ตัด session ผู้ใช้นั้นทันที**, ปิด email เก่าล็อกอินไม่ได้ |
| 2 | ตรวจกล่อง email ใหม่ | ได้อีเมลยืนยัน token 24 ชม. (ใช้ได้หลังหน่วง 5 นาที); email ใหม่ล็อกอินไม่ได้จนกว่าจะยืนยัน |
| 3 | ตรวจกล่อง email เก่า | ได้อีเมล "this wasn't me — revert + freeze" token 48 ชม. |
| 4 | ดู audit | มี `member_contact_email_changed` (high) **แถวเดียว** — payload บรรจุ `sessions_revoked` (จำนวน session ที่ตัด), `verification_enqueued: true`, `revert_enqueued: true` (ไม่มี audit row แยกสำหรับ session-revoked / email-sent — ข้อมูลอยู่ใน payload; enum `email_verification_sent` / `email_change_notification_sent_to_old_address` ยังไม่ถูก emit) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MBR-18 — Revert token (ไม่ใช่ฉัน) จากอีเมลเก่า
**อ้างอิง:** FR-012b, § Security considerations · **บทบาท:** ผู้ถืออีเมลเก่า (unauthenticated)

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | คลิก token "this wasn't me" จากอีเมลเก่าภายใน 48 ชม. | ย้อน email กลับ (contact + user), invalidate token ยืนยันใหม่, flag user `requires_password_reset` |
| 2 | ดู audit | มี `member_email_change_reverted` (high severity) |
| 3 | ผู้ใช้อีเมลเก่าลองล็อกอิน | ต้องทำ password reset ก่อนจึงใช้งานได้ |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MBR-19 — Re-send verification email หลังส่งล้มเหลวถาวร (API-only)
**อ้างอิง:** US3-AS7, FR-012c · **บทบาท:** admin
> ⚠️ **UI ยังไม่ทำ — API-only:** ปัจจุบัน **ยังไม่มีปุ่ม "Re-send verification email"** บนหน้ารายละเอียดสมาชิก (route มีแล้ว แต่ยังไม่มี component เรียก). อย่า fail TC นี้เพราะหาปุ่มไม่เจอ — ให้ทดสอบ endpoint ตรง: `POST /api/members/:memberId/contacts/:contactId/resend-verification` (admin-only)

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | จำลอง outbox ล้มเหลวถาวร (retry หมด → `permanently_failed`) สำหรับอีเมลยืนยันของผู้ติดต่อที่ผูกพอร์ทัล | มี outbox row สถานะ `permanently_failed` พร้อมให้ re-send |
| 2 | ในฐานะ admin ยิง `POST /api/members/:memberId/contacts/:contactId/resend-verification` (เช่น ผ่าน REST client) | **200** `{ outbox_row_id, invalidated_prior }`; ออก token ยืนยัน 24 ชม. + outbox row ใหม่; audit `email_verification_resent`; ไม่ต้องพึ่ง DB operator |
| 3 | ยิงเมื่อผู้ติดต่อ **ไม่เข้าเงื่อนไข** (ไม่มี linked user / email ยืนยันแล้ว / ผู้ติดต่อถูกลบ) | **409** `not_eligible` (ไม่ออก token ใหม่) — เงื่อนไขจริงคือ `no_linked_user` / `email_verified` / `contact_removed` (ไม่ได้ gate ที่ outbox ล้มเหลว) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MBR-20 — เชิญผู้ติดต่อเข้าพอร์ทัล
**อ้างอิง:** US1-AS5, FR-012 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | แถวผู้ติดต่อที่มี email + ยังไม่ผูกบัญชี → **Invite to portal** | toast "Invitation sent."; เกิด badge "Expires in N days" |
| 2 | ตรวจอีเมลผู้ติดต่อ | ได้อีเมลเชิญ scoped member + role member (token 7 วัน) |
| 3 | รับเชิญสำเร็จ | badge เปลี่ยนเป็น "Portal linked" |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MBR-21 — อีเมลเชิญ bounce → badge + Re-send invite
**อ้างอิง:** Edge: Invitation email bounce · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | จำลองอีเมลเชิญตีกลับ (Resend `email.bounced`) | ผู้ติดต่อมี badge "Invite bounced" (แสดงบน**หน้ารายละเอียดสมาชิก** ในบล็อกผู้ติดต่อ — directory ยังไม่มีสัญญาณระดับแถว); audit `invitation_bounced` |
| 2 | กด **Re-send invite** | ส่งคำเชิญใหม่ + เคลียร์ flag bounce; toast "Invitation re-sent." |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MBR-22 — Inline status toggle + optimistic rollback
**อ้างอิง:** US4-AS1, FR-018 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ในตาราง คลิก badge Status ของสมาชิก Active | สลับเป็น Inactive ทันที (optimistic) + toast "Status updated"; audit `member_status_changed` |
| 2 | จำลอง server error ระหว่าง save | ค่าถูก **ย้อนกลับ** + toast "Save failed. Reverted." |
| 3 | ดูแถวที่ Archived | Status เป็น badge เฉยๆ (สลับ inline ไม่ได้) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MBR-23 — Bulk archive (พิมพ์วลียืนยัน + all-or-nothing)
**อ้างอิง:** US4-AS3, US4-AS4, FR-019, FR-026 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ติ๊กเลือกหลายแถว | แถบ Bulk actions โผล่ด้านล่าง บอก "N selected" |
| 2 | กด **Archive** | กล่องยืนยันลิสต์ชื่อบริษัท (ตัด "…and N more" ถ้าเกิน 5) + ต้องพิมพ์วลี "Archive N members" |
| 3 | ยืนยัน | archive ทั้งชุด (all-or-nothing) + audit ต่อราย; ถ้า 1 รายล้มเหลว rollback ทั้งชุด ไม่มี partial commit |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MBR-24 — Bulk send portal invite (สรุป queued/skipped/failed)
**อ้างอิง:** US4-AS (bulk invite), FR-019 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เลือกหลายแถว → **Send invite** → ยืนยัน | toast สรุป "N invitation(s) queued · M skipped · K failed" (success/info/error ตามผล) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MBR-25 — Bulk cap 100 แถว + rate limit
**อ้างอิง:** FR-019a, FR-019b · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เลือก > 100 แถว | ปุ่ม bulk disable + ข้อความ "Maximum 100 members per batch. Split the selection." + helper บอกขั้นถัดไป |
| 2 | ทำ bulk เกิน 10 ครั้งใน 10 นาที | ได้ 429 + toast "Too many bulk actions. Wait a few minutes and try again."; audit `bulk_action_rate_limit_exceeded` |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MBR-26 — manager เป็นสิทธิ์อ่านอย่างเดียว
**อ้างอิง:** US4-AS5, FR-004 · **บทบาท:** manager

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ล็อกอิน manager → เปิด Members | เห็นรายการ + ค้นหา/กรองได้; เห็นแถบ "Read-only view…"; **ไม่มีปุ่ม Add member** |
| 2 | เปิดหน้ารายละเอียดสมาชิก | **ไม่มี** Edit / Archive / Add contact / Invite / Make primary / Remove |
| 3 | คลิก badge Status ในตาราง | ไม่ใช่ปุ่มสลับ (อ่านอย่างเดียว) |
| 4 | เข้า URL ตรง `/admin/members/new` และ `/admin/members/:id/edit` | ได้ **404** ทั้งคู่ |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MBR-27 — member เห็นเฉพาะบริษัทตัวเอง (tenant/cross-member isolation)
**อ้างอิง:** US5-AS1, FR-013, FR-022 · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ล็อกอิน member → ไป `/portal` | เห็นบริษัทตัวเอง + plan + ผู้ติดต่อ + renewal history เท่านั้น |
| 2 | เข้า URL `/admin/...` | ถูกปฏิเสธ (403/redirect — ไม่เข้าฝั่ง admin) |
| 3 | เข้า URL สมาชิกอื่น (member id อื่น) | 403/404 ตาม F1 not-authorised; ไม่รั่วข้อมูลคนอื่น |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MBR-28 — member แก้ whitelist field ได้, field ต้องห้ามถูกปฏิเสธ 403
**อ้างอิง:** US5-AS2, US5-AS3, FR-014, FR-014a, FR-042, SC-007 · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | `/portal` → **Edit Profile** | เห็นเฉพาะ First/Last name, Phone, Preferred Language, Website, Description; field admin-only **ซ่อนทั้งหมด** (ไม่ disable) |
| 2 | แก้ Phone → **Save Changes** | บันทึกสำเร็จ + toast "Profile updated successfully."; audit `member_self_updated` (fields_changed) |
| 3 | จำลอง forge payload ส่ง plan/turnover/status | server ปฏิเสธ **403**; audit `member_self_update_forbidden` (redacted) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MBR-29 — member เชิญเพื่อนร่วมงาน (เฉพาะ Primary)
**อ้างอิง:** US5-AS4, FR-015 · **บทบาท:** member (primary + non-primary)

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ล็อกอินเป็น **Primary contact** → `/portal/contacts/invite` กรอกชื่อ+อีเมล+role → **Send Invitation** | ออกคำเชิญ F1 scoped member ตัวเอง; toast "Invitation sent successfully." |
| 2 | ล็อกอินเป็น **non-primary** เปิดหน้าเดียวกัน | ขึ้น "Only the primary contact can invite colleagues." (ทั้ง UI + server) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MBR-30 — READ_ONLY_MODE: member edit ได้ 503
**อ้างอิง:** US5-AS5 · **บทบาท:** member · **เงื่อนไข:** `READ_ONLY_MODE=true`

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิด read-only mode → member แก้ Profile แล้ว Save | edit คืน 503 `read-only-mode`; การอ่าน (Profile) ยังใช้ได้ |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MBR-31 — Timeline เรียงใหม่สุดก่อน + actor + i18n
**อ้างอิง:** US6-AS1, US6-AS2, FR-020 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | สมาชิกที่มีหลาย event → หน้ารายละเอียด → **View all activity** | หน้า Timeline แสดง event **ใหม่สุดก่อน** พร้อมเวลา (ค.ศ. เก็บ / พ.ศ. แสดง th-TH), ชื่อผู้กระทำ (หรือ "System"), label localised, สรุป diff |
| 2 | กด **Load older activity** | โหลดเพิ่มทีละ 50 ไม่ค้างหน้าจอ; query ยัง tenant+member scoped |
| 3 | กรอง source / actor / ช่วงวันที่ | รายการกรองถูกต้อง |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MBR-32 — member ดู timeline ตัวเอง (redacted)
**อ้างอิง:** US6-AS3 · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | member เปิด timeline ตัวเอง | เห็นเฉพาะ event ของตัวเอง; field admin-only (override reason, internal notes) ถูก redact |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MBR-33 — Archive สมาชิก + ซ่อนจาก directory + ตัด session พอร์ทัล
**อ้างอิง:** US7-AS1, US7-AS4, FR-005, FR-026 · **บทบาท:** admin + member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | หน้ารายละเอียด (Active) → **Archive member** → ใส่ Reason (optional) → **Archive** | สถานะ **Archived**, ตั้ง archived_at, ซ่อนจาก default directory, audit `member_archived`; toast "{company} archived." |
| 2 | ที่ Members default view | สมาชิกนั้นหายไป; เลือก Status=**Archived** จึงเห็น |
| 3 | member ที่ผูกกับสมาชิกนี้ลองล็อกอิน `/portal` | ถูกตัด session / 403 "account inactive" (ไม่บอกเหตุผลเชิงลึก) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MBR-34 — Restore ภายใน 90 วัน + เกิน 90 วันปุ่ม disable
**อ้างอิง:** US7-AS2, US7-AS3, SC-009 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | สมาชิก Archived (ภายใน 90 วัน) → แบนเนอร์ "Archived on {date}" กด **Restore** | สถานะกลับ **Active**, เคลียร์ archived_at, audit `member_undeleted`; toast "Member restored." |
| 2 | สมาชิก Archived เกิน 90 วัน → เปิดหน้ารายละเอียด | ปุ่ม **Restore** disable + tooltip "Archived > 90 days — contact a system admin to restore."; ข้อมูลยังอ่านได้ |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MBR-35 — Cross-tenant probe คืน 404 + audit
**อ้างอิง:** Edge: Cross-tenant probe, FR-021, FR-022, SC-005 · **บทบาท:** admin (tenant A)

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | admin ของ tenant A เปิด URL `/admin/members/<uuid ของ tenant B>` | คืน **404** (ไม่ใช่ 403/401); ไม่รั่วข้อมูล tenant B |
| 2 | ดู audit | มี `member_cross_tenant_probe` (attempted_member_id, actor_user_id, actor_tenant_id) ผูกกับ admin ที่กดจริง |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-MBR-36 — Empty states + a11y/i18n สามภาษา
**อ้างอิง:** FR-034, FR-024, FR-025, FR-035 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | directory ที่ยังไม่มีสมาชิก | empty state "No members yet" + CTA "Add your first member" |
| 2 | ใส่ฟิลเตอร์ที่ไม่ match อะไร | "No members match these filters" + CTA "Clear filters" |
| 3 | จำลอง server error ของ list | error state "Could not load members" + ปุ่ม "Retry" |
| 4 | สลับภาษา EN/TH/SV ในหน้า Members + Add member | ทุก string แปลครบ; `<html lang>` ตรง locale; ฟิลด์บังคับมี asterisk + aria-required |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## สรุปผล + การลงนามรับรอง (ชุด F3 Members)

| รายการ | ค่า |
|---|---|
| จำนวน TC ทั้งหมด | 36 |
| ผ่าน | ______ |
| ไม่ผ่าน | ______ (ระบุเลข TC: __________) |
| รันบน (preview URL) | __________________________ |
| วันที่ทดสอบ | __________ |

| บทบาท | ชื่อ | ลายเซ็น | วันที่ |
|---|---|---|---|
| ผู้รับรอง UAT (SweCham) | | | |
| ผู้ดูแลระบบ | | | |

> ปัญหาที่พบให้บันทึกใน `docs/Bug/` หรือ issue และอ้างเลข TC ที่ไม่ผ่าน
