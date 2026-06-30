# UAT: แดชบอร์ด + Audit + Timeline + Benefits + Directory + Export (F9 Insights)

> **คู่มือ flow นี้:** [../../user-guide/admin/dashboard.md](../../user-guide/admin/dashboard.md)
> **ที่มา:** `specs/015-admin-dashboard/spec.md` (US1–US6 + FR-001…FR-037 + Success Criteria SC-001…SC-013)
> **รันบน:** preview deploy (ไม่ใช่ production) · บัญชี: admin, manager, member

## ก่อนเริ่ม (Preconditions รวม)
- [ ] `FEATURE_F9_DASHBOARD=true` ตั้งใน env ของ tenant ที่ทดสอบ
- [ ] `EXPORT_DOWNLOAD_TOKEN_SECRET` ตั้งแล้ว (≥32 ตัว, ไม่ซ้ำ secret อื่น) — มิฉะนั้นแอปจะ boot ไม่ขึ้น
- [ ] มีข้อมูล F1–F8 พร้อม: สมาชิกหลายราย (มี active / at-risk / overdue), ใบแจ้งหนี้ (มี paid + overdue), การชำระเงิน, broadcast (มีบางอันรออนุมัติ), event registration, การต่ออายุ — เพื่อให้ KPI/ฟีด/timeline/benefit มีของจริงให้ตรวจ
- [ ] มีสมาชิกอย่างน้อย 1 รายที่ตั้ง directory listing เป็น **Listed** (เปิดบางฟิลด์ + ซ่อนอีเมล) และอย่างน้อย 1 รายที่ **ไม่ Listed** — สำหรับทดสอบ E-Book/JSON
- [ ] มีบัญชี admin, manager, member ที่ใช้ล็อกอินได้ (member ผูกกับ member record ที่มีข้อมูล)
- [ ] (ทดสอบ isolation) มี tenant ที่สอง หรือวิธีพิสูจน์ว่าไม่มี cross-tenant leak

**วิธีกรอก:** แต่ละ TC ทำเครื่องหมาย ✅ ผ่าน / ❌ ไม่ผ่าน ในช่อง "ผล" + ใส่หลักฐาน (ภาพหน้าจอ / ค่าที่เห็น / เลข job) ในช่อง "หมายเหตุ"

---

## TC-DASH-01 — แดชบอร์ดแสดง KPI + รายได้ + freshness
**อ้างอิง:** US1-AS1, FR-001, SC-001, SC-002 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ล็อกอิน admin → เปิด `/admin` | เห็นแดชบอร์ดจริง (ไม่ใช่ roadmap placeholder) |
| 2 | ดูแถบ **Key metrics** บนสุด | มี 4 KPI: **Total members / Active members / At-risk members / Paid revenue (YTD)** แต่ละตัวมีป้ายกำกับ + ค่าที่ถูกต้องตรงกับข้อมูล seed |
| 3 | ตรวจตัวเลขรายได้ | **Paid revenue (YTD)** เป็นสกุล THB ตรงกับยอดชำระสะสมทั้งปี |
| 4 | ดูใต้หัวข้อหน้า | แสดง **"As of {time}"** (freshness ของ snapshot ในเขตเวลาหอการค้า) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-DASH-02 — Needs attention พร้อมจำนวน + deep link
**อ้างอิง:** US1-AS2, FR-002 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ดูการ์ด **Needs attention** | แสดงเฉพาะรายการที่มีค่า > 0: Overdue invoices / At-risk members / Broadcasts awaiting approval พร้อมจำนวน |
| 2 | คลิก **Overdue invoices** | ไปหน้า Invoices ที่กรอง status=overdue |
| 3 | คลิก **At-risk members** | ไปหน้า Members ที่กรอง 3 ระดับเสี่ยง (critical, at-risk, warning) — ไม่ใช่แค่ระดับเดียว |
| 4 | คลิก **Broadcasts awaiting approval** | ไปหน้า Broadcasts |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-DASH-03 — ฟีดกิจกรรมล่าสุด (near-real-time)
**อ้างอิง:** US1-AS3, FR-003 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ก่อโดยทำเหตุการณ์สด (เช่น บันทึกชำระเงิน 1 ใบ) แล้วกลับมา `/admin` | การ์ด **Recent activity** แสดงเหตุการณ์นั้นโดยไม่ต้องรอ snapshot รีเฟรช (ฟีดดึงสด) |
| 2 | ดูลำดับ | เรียงใหม่→เก่า (reverse-chronological) มีผู้กระทำ + การกระทำ (label แปลตามภาษา) + เวลาแบบสัมพัทธ์ |
| 3 | กด **Refresh** | ฟีดอัปเดต (มี announce แบบ polite — ไม่ขโมยโฟกัสคีย์บอร์ด) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-DASH-04 — กราฟแนวโน้ม + ตารางข้อมูลสำหรับ SR
**อ้างอิง:** FR-001a, SC-010 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ดูส่วน **Trend charts** | มี **Revenue trend (12 months)** + **Member growth (12 months)** |
| 2 | ตรวจการ์ดแต่ละกราฟ | มีสรุปยอด (12-month total / Total members) + ป้ายเดือน; ถ้ายังไม่มีข้อมูลขึ้น empty/sparse label ไม่ใช่ NaN |
| 3 | ตรวจ accessibility | กราฟมีตารางข้อมูลเทียบเท่า (visually-hidden) และไม่สื่อความหมายด้วยสีอย่างเดียว |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-DASH-05 — Smart insights + dismiss
**อ้างอิง:** US1 (smart insights), FR-004 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ดูการ์ด **Smart insights** | แสดง insight จากชุด starter (เช่น unused E-Blast quota / under-used event tickets / at-risk follow-up) พร้อมจำนวน |
| 2 | กด **Dismiss insight** บนรายการหนึ่ง | รายการหายไป (toast "Insight dismissed"); refresh แล้วยังไม่กลับมา (ไม่ต้องรอ cron) |
| 3 | (ถ้าไม่มี insight) | การ์ดขึ้น "No insights right now — all clear." |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-DASH-06 — manager เห็นแดชบอร์ดเต็ม (รวมรายได้) read-only
**อ้างอิง:** US1-AS4, FR-007, SC-011 · **บทบาท:** manager

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ล็อกอิน manager → เปิด `/admin` | เห็นแดชบอร์ดเต็มเหมือน admin |
| 2 | ตรวจ Paid revenue (YTD) + Revenue trend chart | **แสดงรายได้ครบ** (manager read-only on finance — ดูเงินได้) |
| 3 | มองหาปุ่มแก้/drill-down การเงิน | **ไม่มี** — F9 เป็นหน้าอ่านอย่างเดียวสำหรับทุก staff |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-DASH-07 — member เข้าแดชบอร์ด staff ไม่ได้
**อ้างอิง:** US1-AS5, FR-007, SC-011 · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ล็อกอิน member → พิมพ์ URL `/admin` ตรง | ถูกปฏิเสธ — ไม่เข้าแดชบอร์ด staff (พากลับ portal / ปฏิเสธ) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-DASH-08 — empty state เมื่อ tenant ไม่มีข้อมูล
**อ้างอิง:** US1-AS6, FR-006, Edge "Empty tenant" · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิด `/admin` บน tenant ที่เพิ่ง onboard (ไม่มีข้อมูล) | ทุกส่วน (KPI/needs-attention/feed/charts/insights) ขึ้น empty state ที่เป็นมิตร — **ไม่มี error, ไม่มี "0/NaN" artefact** |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-DASH-09 — ฟีเจอร์ปิด: หน้าแสดง placeholder / 404
**อ้างอิง:** SC-013 (rollback flag), FR-001 (replace placeholder) · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ตั้ง `FEATURE_F9_DASHBOARD=false` → เปิด `/admin` | เห็น **placeholder roadmap (F3–F6)** แทนแดชบอร์ด (ไม่ error) |
| 2 | เปิด `/admin/audit` และ `/admin/directory` | ได้ **404 Not found** ทั้งคู่ |
| 3 | (member) เปิด `/portal/profile/directory` | ได้ **404** |
| 4 | คืนค่า `FEATURE_F9_DASHBOARD=true` ก่อนทดสอบ TC ถัดไป | แดชบอร์ด/audit/directory กลับมาใช้ได้ |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-AUDIT-01 — กรอง audit ตาม event type + ช่วงวันที่
**อ้างอิง:** US2-AS1, FR-008, FR-009, SC-003 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิด `/admin/audit` | ตารางแสดง audit ของ tenant ใหม่สุดอยู่บน |
| 2 | ตั้ง **Event type** = role/tier change ที่มีจริง + ช่วง **From/To** | แสดงเฉพาะเหตุการณ์ที่ตรงชนิด + อยู่ในช่วง เรียงใหม่→เก่า |
| 3 | ตรวจตัวเลือก Event type | มีชนิดครบทุกหมวด (member/invoice/broadcast/renewal/plan/event/auth/payment...) ไม่ใช่แค่ auth+payment |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-AUDIT-02 — กรองตาม target record (เห็นทุกเหตุการณ์ของเรคคอร์ด)
**อ้างอิง:** US2-AS2, FR-009 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ใส่ **Target record** = สมาชิกรายหนึ่ง | แสดงทุก audit ที่อ้างถึงเรคคอร์ดนั้น **ไม่ว่าใครเป็นผู้กระทำ** |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-AUDIT-03 — Export CSV ของชุดที่กรอง + dual timestamp
**อ้างอิง:** US2-AS3, FR-012, SC-004 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ตั้งตัวกรอง (เช่น role changes ทั้งปี) → กด **Export CSV** | ดาวน์โหลดไฟล์ที่มี **เฉพาะ** เหตุการณ์ที่กรองไว้พอดี |
| 2 | เปิดไฟล์ตรวจ timestamp | มีทั้ง **UTC** และเวลาท้องถิ่นที่อ่านได้ (ไม่กำกวม) |
| 3 | กลับไป `/admin/audit` ตรวจว่ามี audit รายการ "export" | การกด Export ถูกบันทึกลง audit เอง |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-AUDIT-04 — manager: redact payload, เห็น Actor
**อ้างอิง:** US2-AS4, FR-011, SC-011 · **บทบาท:** manager

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ล็อกอิน manager → เปิด `/admin/audit` หาเหตุการณ์ที่มี payload sensitive (เช่น override reason / staff note / PII คนอื่น) | ฟิลด์ sensitive ใน **Details** ถูก redact ตามสิทธิ manager |
| 2 | ตรวจคอลัมน์ **Actor** | **เห็นชื่อผู้กระทำ** (actor identity ไม่ถูก redact สำหรับ manager) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-AUDIT-05 — audit อ่านอย่างเดียว (append-only)
**อ้างอิง:** US2-AS5, FR-010 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | สำรวจหน้า `/admin/audit` ทั้งหน้า | **ไม่มี** ปุ่ม/ลิงก์ใดให้แก้ไขหรือลบรายการ audit (read-only ล้วน) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-AUDIT-06 — pagination + invalid filter
**อ้างอิง:** FR-008 (keyset pagination), AS error-handling · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ในชุดผลที่มี > 50 รายการ กด **Older** | แสดงหน้าเก่ากว่า (keyset) แทนที่หน้าเดิม ไม่ค้าง |
| 2 | จากหน้าที่เลื่อนมาแล้ว กด **Newer** | กลับไปหน้าที่ใหม่กว่า (1 หน้า) ได้ถูกต้อง ไม่ซ้ำ/ไม่ตกหล่น |
| 3 | กด **Latest** | กระโดดกลับหน้าล่าสุด (ใหม่สุด) คลิกเดียว |
| 4 | แก้ URL ใส่ `from`/`to` รูปแบบผิด (เช่น `from=99-99-99`) | ขึ้นสถานะ **"Invalid filter"** (ไม่ throw / ไม่ขาว) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-TL-01 — timeline รวมทุกแหล่งเรียงเวลา
**อ้างอิง:** US3-AS1, FR-014, SC-005 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิด member ที่มีหลายแหล่ง → `/admin/members/{id}/timeline` | รวม invoice/payment/event/broadcast/audit เป็นสายเดียว เรียงใหม่→เก่า มีไอคอน/ป้ายต่อแหล่ง (Profile/Audit · Invoice · Payment · Event · E-Blast · Renewal) |
| 2 | เทียบกับข้อมูลจริง | 100% ของเหตุการณ์ที่มีอยู่ปรากฏครบ ในลำดับเวลาถูกต้อง |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-TL-02 — กรอง timeline ตามแหล่ง + วันที่ + ประวัติยาว
**อ้างอิง:** US3-AS2, US3-AS3, FR-015, FR-016 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ตั้ง Filters **Source** = Invoice + ช่วงวันที่ | แสดงเฉพาะ invoice ในช่วงนั้น; กด **Clear filters** กลับมาครบ |
| 2 | ตั้ง **Actor** = Staff/Member/System | กรองตามชนิดผู้กระทำได้ |
| 3 | บน member ที่มีประวัติยาว (1,000+) เลื่อนลง / **Load older activity** | โหลดเพิ่มทีละหน้า ลื่น ไม่ค้างหน้าจอ |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-TL-03 — member เห็น timeline ตัวเอง + redact + กันข้ามคน
**อ้างอิง:** US3-AS4, FR-017 · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ล็อกอิน member → `/portal/timeline` | เห็นประวัติของตัวเอง สายเดียวกัน |
| 2 | ตรวจฟิลด์ภายใน (override reason / staff note) | ถูก redact (ไม่โผล่) |
| 3 | พยายามดู timeline ของสมาชิกคนอื่น (ไม่มี route param ให้แก้ — resolve จาก session) | **ไม่มีทางเห็นของคนอื่น** |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-TL-04 — แหล่งที่ไม่มีข้อมูลไม่ทำให้ error
**อ้างอิง:** US3-AS5, FR-018, Edge "no entries" · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิด timeline ของ member ที่บางแหล่งไม่มีข้อมูล (เช่น ไม่เคยมี payment) | แหล่งที่ไม่มีข้อมูล **ไม่ปรากฏแถวว่าง/ไม่ error** — สายแสดงเฉพาะที่มีจริง |
| 2 | member ที่ไม่มีกิจกรรมเลย | ขึ้น empty label ("No activity recorded yet.") ไม่ error |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-BEN-01 — benefit usage: used/quota + last used + deep link
**อ้างอิง:** US4-AS1, FR-019, SC-006 · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ล็อกอิน member บน plan ที่ให้ E-Blast (เช่น 6 อัน ใช้ไป 2) → `/portal/benefits` | การ์ด **Benefit usage · {ปี}** แสดง E-Blasts "2 of 6 used" + วันที่ใช้ล่าสุด |
| 2 | ตรวจ deep link compose | มีลิงก์ไป compose E-Blast (`/portal/broadcasts/new`) |
| 3 | กระทบยอดกับข้อมูลจริง | ตัวเลข used/entitlement ตรงกับ consumption จริง |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-BEN-02 — under-use warning ที่เกณฑ์ถูกต้อง
**อ้างอิง:** US4-AS2, FR-021 · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | member ที่ผ่านปีไป ~62% แต่ใช้สิทธิ ~33% (ช่องว่าง ≥25 จุด) | ขึ้นกล่องเตือน **"You're not using all your benefits"** + "At {x}% of the year you've used {y}%..." + ลิงก์ใช้สิทธิ |
| 2 | member ที่ใช้สิทธิตามเกณฑ์ / ไม่มี benefit ที่นับได้ | **ไม่มี** กล่องเตือน |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-BEN-03 — benefit ที่ไม่จำกัดแสดงเป็น active ไม่ใช่โควตา
**อ้างอิง:** US4-AS3, FR-020 · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | member ที่มี benefit แบบ unlimited/active-only (เช่น all-employee discount, directory listing) | แสดงใน **Included benefits** เป็น มี/active — ไม่ใช่ตัวเลขโควตา |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-BEN-04 — staff เห็น benefit ตรงกับ member + ปุ่ม Send reminder (เปิดผ่านปุ่ม **Benefits**)
**อ้างอิง:** US4-AS4, FR-022 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | admin เปิด `/admin/members/{id}/benefits` ของ member เดียวกับ TC-BEN-01 | ตัวเลข used/entitlement **ตรงกับ** ที่ member เห็นทุกอย่าง |
| 2 | ตรวจปุ่มเฉพาะ staff | มีปุ่ม **Send reminder** (เปิด mailto ถึง primary contact) — มีเฉพาะเมื่อ member มี primary contact ใช้งานอยู่ |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-BEN-05 — โควตารีเซ็ตเมื่อขึ้นปีใหม่
**อ้างอิง:** US4-AS5, FR-023 · **บทบาท:** member หรือ admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ดู benefit ของปีปัจจุบัน (ปีปฏิทินตามเขตเวลาหอการค้า) | โควตาสะท้อน entitlement ปีปัจจุบัน; การใช้ปีก่อน **ไม่ถูกนับทับ** ปีนี้ |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-DIR-01 — ค้น directory ภายในด้วย keyword + tier
**อ้างอิง:** US5-AS1, FR-024 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิด `/admin/directory` → ค้น keyword (company/industry/description) + ฟิลเตอร์ **Tier** | แสดงสมาชิกที่ตรง พร้อมคอลัมน์ Company/Tier/Industry/Location/Listed/Logo/Contact |
| 2 | ตรวจขอบเขต | staff ค้นเห็น **ทุก** สมาชิก (รวมที่ไม่ Listed) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-DIR-02 — สร้าง E-Book (PDF): เฉพาะ opt-in + เฉพาะฟิลด์ที่เลือก
**อ้างอิง:** US5-AS2, US5-AS5, FR-026, FR-028, SC-007 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | กด **Generate E-Book (PDF)** | toast "Generation queued…"; การ์ด **Recent exports** ขึ้นงานใหม่ status Queued→Generating→**Ready** |
| 2 | กด **Download** เมื่อ Ready | ได้ PDF จัดรูปแบบสวย มี branding หอการค้า เรนเดอร์ภาษา default ของ tenant (EN) |
| 3 | ตรวจเนื้อหา | มี **เฉพาะ** สมาชิกที่ **Listed** และ **เฉพาะฟิลด์ที่แต่ละคนเลือกเปิด** — สมาชิกที่ไม่ Listed ไม่ปรากฏ |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ (เลข job/ภาพ):** ____________________

---

## TC-DIR-03 — Export JSON: structure ถูก + เคารพ field hiding
**อ้างอิง:** US5-AS3, US5-AS4, FR-027, FR-028, SC-007 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | กด **Export data (JSON)** → รอ Ready → Download | ได้ไฟล์ JSON มีโครงสร้าง nested เหมาะให้เว็บไซต์ใช้ |
| 2 | ตรวจสมาชิกที่ซ่อนอีเมล | อีเมลถูก **ละ** (หรือแทนด้วยตัวบ่งชี้ contact-form) ในไฟล์ |
| 3 | ตรวจรายชื่อ | มีเฉพาะ opt-in listings + เฉพาะฟิลด์ที่เลือก |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-DIR-04 — member ตั้งค่า directory listing (opt-in + ฟิลด์ + โลโก้)
**อ้างอิง:** FR-025, FR-025a · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | member → `/portal/profile/directory` | ค่าเริ่มต้น **List my organisation...** = ปิด (private), Contact email = ซ่อน |
| 2 | เปิด Listed + ติ๊กฟิลด์ + กรอก details → **Save** | บันทึกสำเร็จ ("Directory listing saved.") |
| 3 | **Upload logo** ไฟล์ PNG/JPEG/WebP ≤2 MB | อัปโหลดสำเร็จ (re-encode + strip EXIF); ลองไฟล์ >2 MB / ฟอร์แมตผิด → ขึ้น error ที่ถูกต้อง |
| 4 | (verify) admin สร้าง E-Book/JSON ใหม่ | สมาชิกรายนี้ปรากฏตามที่เพิ่งตั้ง (ไฟล์เก่าไม่เปลี่ยน — ต้อง generate ใหม่) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-GDPR-01 — member ขอ export ข้อมูลตัวเอง
**อ้างอิง:** US6-AS1, US6-AS2, FR-029, SC-008 · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | member → `/portal/account#data-privacy` → กด **Request my data export** | สถานะ **Preparing** → **Ready to download** |
| 2 | กด **Download** | ได้ archive มี profile/contacts/invoices(+PDF)/events/broadcasts/audit-events ของตัวเอง + README + manifest.json |
| 3 | ตรวจ manifest | manifest.json มี checksum (SHA-256) ของทุกไฟล์ — validate ผ่าน |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-GDPR-02 — ลิงก์ดาวน์โหลดหมดอายุ + บันทึก audit
**อ้างอิง:** US6-AS3, FR-030 · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | หลัง Ready ปล่อยลิงก์ดาวน์โหลดทิ้งไว้เกินหน้าต่างเวลา (~1 ชม.) | ลิงก์หมดอายุ (status **Expired**) — ต้องขอ export ใหม่ |
| 2 | ตรวจ `/admin/audit` | มีรายการบันทึกทั้ง **คำขอ** และ **การส่งมอบ** export |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-GDPR-03 — admin ออก export แทน (on-behalf) + attribute
**อ้างอิง:** US6-AS4, FR-031, FR-032a · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | admin เปิด `/admin/members/{id}` → การ์ด **Data export (GDPR)** → **Request my data export** | สร้าง archive แบบเดียวกับที่ member ได้ |
| 2 | ตรวจ `/admin/audit` | การกระทำถูก attribute ว่า **admin คนนี้** เป็นผู้ออก |
| 3 | (ถ้ามี) member archived | ยัง export ได้ (สิทธิ portability ยังอยู่) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-GDPR-04 — member ห้าม export ข้อมูลคนอื่น
**อ้างอิง:** US6-AS5, FR-032 · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | member พยายามขอ/ดาวน์โหลด export ของสมาชิกคนอื่น (memberId resolve จาก session เท่านั้น) | **ถูกปฏิเสธ** — export ได้เฉพาะของตัวเอง |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-ENG-01 — Engagement score: แสดง/เรียง/กรองในรายชื่อสมาชิก
**อ้างอิง:** FR-007a, FR-035 (ไม่พึ่งสีอย่างเดียว) · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิด `/admin/members` ดูคอลัมน์ **Engagement** | แสดงคะแนน + band (Healthy/Moderate/Watch/Critical) มีป้ายข้อความ ไม่พึ่งสีอย่างเดียว |
| 2 | กดหัวคอลัมน์ Engagement เพื่อ sort | เรียงได้ (default DESC = สุขภาพดีก่อน); ค่ากลับของ at-risk (F8) |
| 3 | ตรวจฝั่ง member | member **ไม่เห็น** engagement score (staff-facing เท่านั้น) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-ISO-01 — tenant isolation (ไม่มี cross-tenant leak)
**อ้างอิง:** FR-013, FR-033, SC-009, Edge "Tenant isolation" · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | บนทุกหน้า F9 (dashboard/audit/timeline/directory/export) ตรวจว่าข้อมูลเป็นของ tenant ปัจจุบันเท่านั้น | ไม่มีข้อมูลของ tenant อื่นโผล่เลย |
| 2 | (ถ้าทำได้) ลอง cross-tenant probe เช่นแก้ id ใน URL/filter ให้ชี้ tenant อื่น | คืน **ศูนย์ records** และเหตุการณ์ถูกบันทึกเป็น auditable probe |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-I18N-01 — ครบ 3 ภาษา + Buddhist Era + ไม่มี string ขาด
**อ้างอิง:** FR-034, SC-010 · **บทบาท:** admin + member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | สลับภาษา EN / TH / SV บนทุกหน้า F9 | แปลครบ ไม่มี MISSING_MESSAGE / key ดิบโผล่ |
| 2 | บนภาษา TH ตรวจวันที่ | แสดงปี **พ.ศ.** (Buddhist Era) สำหรับผู้ใช้ แต่ storage ยังเป็น Gregorian UTC |
| 3 | ตรวจการ์ด KPI / คอลัมน์ audit / รายการ directory ในภาษา TH/SV (สตริงยาวกว่า EN) | ไม่ตัดคำผิด/ไม่ล้นกล่อง (รองรับ content-length variance) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-A11Y-01 — accessibility บนหน้า F9
**อ้างอิง:** FR-035, SC-010 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | นำทางด้วยคีย์บอร์ดล้วนบน dashboard/audit/directory | ใช้งานได้ครบ มี skeleton/empty/error state, ตัวกรองมี label, ข้อความ error ถูก announce |
| 2 | ตรวจ Engagement band / benefit level | ไม่สื่อความหมายด้วย **สีอย่างเดียว** (มีข้อความ/ไอคอนด้วย — WCAG 1.4.1) |
| 3 | สลับ light/dark (`prefers-color-scheme`) | ทุกหน้า F9 เคารพ theme ไม่ hard-code scheme เดียว |

> ℹ️ การรันจริง: `@a11y` gate เป็น **preview-only** — local dev อาจมี noise (320px reflow / target-size) ที่ไม่ใช่ regression; รันชี้ขาดบน preview deploy

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## สรุปผล + การลงนามรับรอง (ชุด F9 Insights)

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
| ผู้ลงนาม security checklist (F9 = PII surface, ต้อง ≥2 reviewers) | | | |

> ปัญหาที่พบให้บันทึกใน `docs/Bug/` หรือ issue และอ้างเลข TC ที่ไม่ผ่าน
> F9 เป็น security-sensitive feature (อ่าน PII ทั้งหมด) — ตาม governance ต้องมี ≥2 reviewers โดยหนึ่งคนเซ็น security checklist ก่อน ship
