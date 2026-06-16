# UAT: นำเข้าผู้ร่วมงาน + ติดตามโควตาสิทธิประโยชน์ (F6 — EventCreate Integration)

> **คู่มือ flow นี้:** [../../user-guide/admin/event-import.md](../../user-guide/admin/event-import.md)
> **ที่มา:** `specs/012-eventcreate-integration/spec.md` (US1–US7) + Success Criteria (SC-001…SC-012)
> **รันบน:** preview deploy (ไม่ใช่ production) · บัญชี: admin, manager, member

## ก่อนเริ่ม (Preconditions รวม)
- [ ] `FEATURE_F6_EVENTCREATE` เปิดบน preview
- [ ] มีบริษัทสมาชิกทดสอบ ≥ 2 ราย พร้อม contact email + email domain (F3)
- [ ] มีสมาชิกที่มีแพ็กเกจ (F2) กำหนดโควตา: 1 ราย Partnership tier (เช่น Diamond 6 ตั๋ว/งาน) + 1 ราย Corporate tier (เช่น Premium 2 ตั๋ว cultural/ปี)
- [ ] เตรียมไฟล์ CSV ทดสอบ: 1 ไฟล์ผสม matched/unmatched/refunded; 1 ไฟล์ขนาด ~1,000 แถว (สำหรับ SC-006)
- [ ] ตั้งค่า Zapier หรือเครื่องมือยิง webhook ที่ลงนาม HMAC-SHA256 ได้ (สำหรับ TC ฝั่ง webhook)

**วิธีกรอก:** แต่ละ TC ทำเครื่องหมาย ✅ ผ่าน / ❌ ไม่ผ่าน ในช่อง "ผล" + ใส่หลักฐาน (เลข registration/ภาพหน้าจอ/HTTP status) ในช่อง "หมายเหตุ"

---

## TC-EVT-01 — Webhook นำเข้าผู้ร่วมงาน + จับคู่สมาชิกสำเร็จ
**อ้างอิง:** US1-AS1, SC-002 · **บทบาท:** admin (ตั้งค่า) + ระบบ webhook

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ยิง payload ที่ลงนามถูกต้อง อีเมลตรง contact ของสมาชิก | HTTP **200**, body `matched: "member"` + registration ID |
| 2 | เปิด `/admin/events/{eventId}` | เห็น event row + registration row; ป้าย Match = **Verified contact** |
| 3 | ตรวจ audit log | บันทึก webhook receipt = verified + matched |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ (registration ID):** ____________________

---

## TC-EVT-02 — ผู้ร่วมงานที่ไม่ใช่สมาชิก (Non-member) ไม่ตัดโควตา
**อ้างอิง:** US1-AS2, FR-013 · **บทบาท:** ระบบ webhook + admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ยิง payload ลงนามถูก แต่อีเมล+โดเมนไม่ตรงสมาชิกใด | registration ถูกบันทึก match = **Non-member** |
| 2 | ตรวจโควตา + audit | **ไม่ตัดโควตา**; audit บันทึก non-member outcome |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-EVT-03 — ส่ง webhook ซ้ำ (idempotency) ถูกปฏิเสธ 409
**อ้างอิง:** US1-AS3, FR-004 · **บทบาท:** ระบบ webhook

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ยิง delivery เดิม (`X-Request-ID` เดิม) ครั้งที่ 2 | HTTP **409** + duplicate error body |
| 2 | ตรวจ registration / โควตา / audit | registration เดิมไม่เปลี่ยน, โควตา **ไม่ถูกตัดซ้ำ**, audit บันทึก ingestion เดียว |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-EVT-04 — ลายเซ็น HMAC ผิด ถูกปฏิเสธ 401
**อ้างอิง:** US1-AS4, FR-002, SC-009 · **บทบาท:** ระบบ webhook

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ยิง payload ที่ลายเซ็นผิด (secret ผิด/แก้ body) | HTTP **401**; **ไม่บันทึก** event/registration |
| 2 | ตรวจ audit log | บันทึกเป็น signature-rejected + source IP |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-EVT-05 — Timestamp เพี้ยน > 5 นาที (กัน replay) ถูกปฏิเสธ 401
**อ้างอิง:** US1-AS5, FR-003 · **บทบาท:** ระบบ webhook

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ยิง payload ที่ `X-Chamber-Timestamp` ห่างจากเวลาเซิร์ฟเวอร์เกิน 5 นาที | HTTP **401** (replay protection) แม้ลายเซ็นจะถูกต้องก็ตาม |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-EVT-06 — Payload malformed / ขาดฟิลด์บังคับ ถูกปฏิเสธ 400
**อ้างอิง:** Edge Case (malformed), FR-011a · **บทบาท:** ระบบ webhook

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ยิง payload ลงนามถูก แต่ขาดฟิลด์บังคับ (เช่น attendee_email) | HTTP **400** + field-level error; **ไม่บันทึก** row |
| 2 | ยิง payload ที่มี **ฟิลด์แปลกที่ไม่รู้จัก (unknown keys)** | นำเข้าได้ตามปกติ; ฟิลด์แปลกถูกเก็บใน metadata (ไม่ปฏิเสธ) |
| 3 | ตรวจ audit | บันทึกกรณี malformed |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-EVT-07 — Cross-tenant probe ถูกปฏิเสธ 401
**อ้างอิง:** Edge Case (cross-tenant probe), FR-006, SC-009 · **บทบาท:** ระบบ webhook

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ยิง payload ลงนามด้วย secret ของ Tenant A ไปยัง URL ของ Tenant B | HTTP **401** (signature verify ล้ม); **ไม่มี** ข้อมูลข้ามองค์กร |
| 2 | ตรวจ audit | บันทึกด้วย severity ระดับสูง |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-EVT-08 — รายการงาน: คอลัมน์ + เรียงตามวันที่ + match rate
**อ้างอิง:** US2-AS1, FR-020 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | นำเข้า ≥ 5 งานที่มีจำนวนผู้ลงทะเบียนต่างกัน → เปิด `/admin/events` | ตารางมีคอลัมน์ Date / Name / Category / Registrations / Partner Benefit / Match Rate; เรียงวันที่ใหม่สุดก่อน; มี pagination |
| 2 | ลองตัวกรอง chips + ช่องค้นหา "Search events by name…" | กรอง/ค้นหาได้ตามที่เลือก (URL อัปเดต) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-EVT-09 — รายละเอียดงาน: match rate + ตาราง attendees + ผลโควตา
**อ้างอิง:** US2-AS2, US2-AS4, FR-021 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิดงานที่มี 20 ลงทะเบียน จับคู่ 18 → เข้า detail | ส่วนหัวแสดง **"90% (18 of 20)"**; ตารางมี Attendee / Match / Ticket / Quota / Registered |
| 2 | กด **"Show unmatched only"** | กรองเหลือเฉพาะแถว unmatched / non-member |
| 3 | ลอง **"Filter by payment status"** = Refunded | แสดงเฉพาะตั๋วที่ refunded |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-EVT-10 — ปุ่ม "View on EventCreate" (deep link)
**อ้างอิง:** US2-AS3, FR-021 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ที่หน้ารายละเอียดงานที่มาจาก EventCreate กด **"View on EventCreate"** | เปิดแท็บใหม่ไปยัง `eventCreateUrl` ที่ถูกต้อง |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-EVT-11 — Empty state ตามบริบท (a/b/c)
**อ้างอิง:** US2-AS5, FR-020 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | tenant ที่ยังไม่ตั้งค่า integration → เปิด `/admin/events` | **(a)** "No events yet" + ปุ่ม **"Set up EventCreate integration"** |
| 2 | tenant ที่ตั้งค่าแล้วแต่ยังไม่มี delivery | **(b)** "Waiting for first event" + ปุ่ม **"Send a test event"** |
| 3 | tenant ที่ archive งานหมด | **(c)** "All events are archived" + ปุ่ม **"Show … archived events"** |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-EVT-12 — Onboarding wizard: generate secret + reveal ครั้งเดียว
**อ้างอิง:** US3-AS1, US3-AS3, FR-024, SC-001 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิด Settings → EventCreate (`/admin/settings/integrations/eventcreate`) ครั้งแรก กด **"Generate webhook secret"** | แสดง secret **ครั้งเดียว** + ปุ่ม Copy + คำเตือน "It will not be shown again"; แสดง **Webhook URL** + Zapier walkthrough |
| 2 | ติ๊ก "I've saved this secret…" → reload หน้า | secret ถูก **mask** (เช่น `whsec_••••1234`) + ปุ่ม **"Rotate secret"** (ไม่ reveal ซ้ำ) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-EVT-13 — ปุ่ม "Send test event" รอบ round-trip
**อ้างอิง:** US3-AS2, FR-023 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ที่ Step "Test & manage" กด **"Send test event"** | ภายใน ~30 วิ ขึ้น **"Test event delivered successfully"** |
| 2 | ดู **Recent deliveries** | มีรายการ test ใหม่ (Signature = Verified); ติ๊ก "Include test deliveries" เพื่อแสดง |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-EVT-14 — ตัดโควตา Partnership ครบ 6 ใบ + ใบที่ 7 over quota
**อ้างอิง:** US4-AS1, US4-AS2, FR-015, FR-017, SC-004 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | งาน flag partner benefit + นำเข้า 6 ลงทะเบียนจากบริษัทสมาชิก Diamond (6 ตั๋ว) | ทั้ง 6 ติด **Partner benefit** (counted=true); โควตาเหลือ 0; แต่ละครั้ง audit |
| 2 | นำเข้าใบที่ 7 จากบริษัทเดิม | บันทึกแต่ติดป้าย **Over quota** (counted=false); โควตายังเป็น 0 |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-EVT-15 — ตัดโควตา Cultural รายปี
**อ้างอิง:** US4-AS3, FR-016 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | งาน flag cultural event + สมาชิก Premium Corporate (2 ตั๋ว/ปี) เหลือ 2 → นำเข้า 1 ลงทะเบียน | ติด **Cultural quota** (counted=true); โควตาปีลดจาก 2 → 1 |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-EVT-16 — Refund คืนโควตา (credit back)
**อ้างอิง:** US4-AS4, FR-018 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ส่งลงทะเบียนเดิมอีกครั้งด้วย `payment_status = "refunded"` | แถวอัปเดตเป็น **Refunded**; โควตาที่เคยตัด **คืน +1**; audit บันทึก reversal |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-EVT-17 — Toggle flag → re-evaluate โควตาทั้งงาน
**อ้างอิง:** FR-019 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | งานที่มีผู้จับคู่หลายราย กด **"Flag as partner benefit"** → ยืนยัน | ทุกแถวที่จับคู่ถูก re-evaluate รอบเดียว; สมาชิกมีโควตา → ตัด, เต็ม → over quota; toast สรุปจำนวนที่ re-evaluate |
| 2 | กด **"Remove partner-benefit flag"** → ยืนยัน | โควตาทั้งหมดของงานถูก **คืนกลับ**; audit |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-EVT-18 — นำเข้า CSV: preview + column mapping + ผลสรุป
**อ้างอิง:** US5-AS1, US5-AS2, FR-026, FR-028, SC-006 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิด `/admin/events/import` (หรือปุ่ม "Import CSV") → เลือก **Event** จาก dropdown | submit ถูกล็อกจนกว่าจะเลือกงาน (hint "Select an event…") |
| 2 | ลากวางไฟล์ CSV | แสดง preview 10 แถว + **Detected columns** (จำเป็น=เขียว) |
| 3 | กด **"Confirm and import"** | หน้า **Import complete**: Rows imported / Events created-updated / Match breakdown |
| 4 | นำเข้าไฟล์ ~1,000 แถว | เสร็จภายใน **< 60 วินาที** (SC-006) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-EVT-19 — CSV row ผิด → ข้าม + รายงาน error (ไม่หยุดทั้งไฟล์)
**อ้างอิง:** US5-AS3, FR-029 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | นำเข้า CSV ที่มีบางแถว email ผิด/ขาดคอลัมน์ | แถวผิดถูกข้าม + ขึ้นใน **"Rows with errors"** พร้อมเลขแถว + เหตุผล; แถวที่ดีนำเข้าต่อ |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-EVT-20 — CSV idempotent: นำเข้าซ้ำไม่ตัดโควตาซ้ำ
**อ้างอิง:** US5 / FR-027, SC-004 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | นำเข้าไฟล์เดิมซ้ำครั้งที่ 2 | ผลสรุปขึ้น **"Already imported"**; **ไม่** ตัดโควตาซ้ำ, ไม่สร้าง registration ซ้ำ |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-EVT-21 — ประวัตินำเข้า + ดาวน์โหลด error CSV
**อ้างอิง:** FR-028, FR-029 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิด `/admin/events/import/history` | ตารางแสดง Uploaded / File / Source / Outcome / Processed-Skipped-Failed |
| 2 | กด **"Download error CSV"** บน import ที่มี error | โหลดไฟล์เฉพาะแถวที่พลาด (ถ้าเกิน 30 วันขึ้นป้าย "Expired") |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-EVT-22 — Relink: จับคู่ non-member ให้สมาชิกที่ถูก + คืน/ตัดโควตา
**อ้างอิง:** US6-AS1, US6-AS2, FR-014 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | แถว match = Non-member → คอลัมน์ Actions กด **"Relink"** → เลือกสมาชิก A | match อัปเดต; ถ้าเข้าเงื่อนไขโควตา → ตัด; แสดงผลทันทีไม่รีโหลด; toast "Relinked to …" |
| 2 | Relink แถวที่เคยตัดโควตา A → ไปสมาชิก B | โควตา A **คืน +1**; โควตา B re-evaluate; audit ทั้งสองฝั่ง |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-EVT-23 — Relink ถูกบล็อกบนแถว PII ที่ถูก purge แล้ว
**อ้างอิง:** FR-014 (restriction) · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | แถวที่ `pii_pseudonymised` แล้ว มองหา/กด Relink | ขึ้นข้อความ **"Cannot relink — attendee PII has been retention-purged…"**; ทำไม่ได้ |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-EVT-24 — Rotate secret + grace 24 ชม.
**อ้างอิง:** US7-AS1, US7-AS2, US7-AS3, FR-008, SC-008 · **บทบาท:** admin + ระบบ webhook

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | กด **"Rotate secret"** → **"Rotate now"** | secret ใหม่แสดงครั้งเดียว; secret เก่าได้ `rotated_at`; แสดงเวลา grace สิ้นสุด |
| 2 | ยิง webhook ด้วย secret เก่า ภายใน grace (เช่น T+12h) | **verify ผ่าน**; audit ติดธง deprecated-grace |
| 3 | ยิง webhook ด้วย secret เก่า หลัง 24 ชม. (T+25h) | HTTP **401** + audit บันทึก signature-failure |
| 4 | ยิง webhook ด้วย secret ใหม่ | verify ผ่านทุกครั้งหลัง rotate |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-EVT-25 — Archive งาน: คืนโควตา + ซ่อนจากรายการ default
**อ้างอิง:** FR-019a · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | งานที่มีตั๋วถูกนับโควตา กด **"Archive event"** → ยืนยัน **"Archive"** | งานเป็น quota-neutral; โควตาทุกใบ **คืนกลับ**; toast สรุปจำนวนที่ credit back |
| 2 | กลับไป `/admin/events` | งานหายจากรายการ default; เห็นได้ด้วย **"Show archived events"** + ป้าย **Archived** |
| 3 | บนงานที่ archive แล้ว มองหาปุ่ม Flag/Relink/Archive | **ไม่มี** (งาน quota-neutral แก้ไม่ได้); ไม่มี Un-archive ใน v1 |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-EVT-26 — Erase PII (PDPA §30 / GDPR Art. 17)
**อ้างอิง:** FR-032a, SC-012 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | เปิด `/admin/events/{eventId}/registrations/{registrationId}/erase` | กล่องยืนยัน **"Erase personal data for {ชื่อ}?"** เปิดอัตโนมัติ |
| 2 | กรอก **"Reason for erasure"** (บังคับ) → กด **"Erase PII"** | ชื่อ/อีเมล/บริษัทถูกลบถาวร; โควตา **คืนกลับ**; audit เก็บ admin+เวลา+เหตุผล; toast "Personal data erased" |
| 3 | กลับไปดูแถวในงาน | แถวถูก pseudonymised; **Relink ไม่ได้** |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-EVT-27 — RBAC: manager อ่านอย่างเดียว (no write + 404 บน settings)
**อ้างอิง:** FR-035 · **บทบาท:** manager

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ล็อกอิน manager → เปิด `/admin/events` + เข้า event detail | ดูรายการ + รายละเอียดได้ |
| 2 | มองหาปุ่ม Import CSV / Relink / Archive / Flag toggle | **ไม่มีปุ่ม write** ใด ๆ |
| 3 | ลองเข้า URL `/admin/events/import` ตรง ๆ | **404** (surface disclosure) |
| 4 | ลองเข้า `/admin/settings/integrations/eventcreate` | **404** (กันการเปิดเผยหน้า secret) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-EVT-28 — RBAC: member ไม่มีสิทธิ์เข้า F6 (404)
**อ้างอิง:** FR-035 · **บทบาท:** member

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ล็อกอิน member → ลองเข้า `/admin/events`, `/admin/events/import`, `/admin/settings/integrations/eventcreate` | **404** ทุกหน้า (surface disclosure) |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-EVT-29 — Feature flag ปิด → ทุกหน้า F6 เป็น 404
**อ้างอิง:** FR-034 · **บทบาท:** admin (ใน env ที่ flag = false)

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | ใน env ที่ `FEATURE_F6_EVENTCREATE=false` เข้า `/admin/events` + หน้า F6 อื่น ๆ | **404** ทุกหน้า |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## TC-EVT-30 — i18n + a11y (WCAG 2.1 AA) ทุกหน้า F6
**อ้างอิง:** FR-030, FR-031, SC-010 · **บทบาท:** admin

| # | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| 1 | สลับภาษา EN / TH / SV บน events list, detail, import, settings | ทุก string แปลครบ ไม่มี key ดิบ/`MISSING_MESSAGE` |
| 2 | รัน axe-core (`@a11y`) บนแต่ละหน้า (บน preview) | ผ่าน WCAG 2.1 AA (focusable CTA, contrast, heading order) |
| 3 | วันที่/เวลาในตาราง | แสดงโซน **Asia/Bangkok**; ภาษาไทยแสดง พ.ศ. |

**ผล:** ☐ ผ่าน ☐ ไม่ผ่าน — **หมายเหตุ:** ____________________

---

## สรุปผล + การลงนามรับรอง (ชุด F6 EventCreate Integration)

| รายการ | ค่า |
|---|---|
| จำนวน TC ทั้งหมด | 30 |
| ผ่าน | ______ |
| ไม่ผ่าน | ______ (ระบุเลข TC: __________) |
| รันบน (preview URL) | __________________________ |
| วันที่ทดสอบ | __________ |

| บทบาท | ชื่อ | ลายเซ็น | วันที่ |
|---|---|---|---|
| ผู้รับรอง UAT (SweCham) | | | |
| ผู้ดูแลระบบ | | | |

> ปัญหาที่พบให้บันทึกใน `docs/Bug/` หรือ issue และอ้างเลข TC ที่ไม่ผ่าน
