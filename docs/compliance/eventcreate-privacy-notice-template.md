# F6 EventCreate Privacy Notice Template

**Status**: REVIEW-READY — chamber DPO action required pre-flag-flip
**Owner**: Chamber DPO + legal counsel
**Last reviewed**: 2026-05-12 (Issue H-PDPA-1 from full-scope review)

## Purpose

PDPA §23 + GDPR Art. 13/14 require attendees to be informed **at the
point of collection** about how their personal data will be processed.
F6 ingests attendee data via Zapier from EventCreate, but Chamber-OS
is the **processor**, not the **collector** — the chamber is responsible
for surfacing the notice at the EventCreate registration form.

This file provides ready-to-paste template snippets in EN + TH + SV
for chamber admins to include in their EventCreate event descriptions
(or in a separate privacy-notice link on the EventCreate registration
page). Phase 5 T080 wires this template into the F6 admin wizard so
admins can copy-paste with one click.

The template is **pre-reviewed** with this commit so chamber DPO + legal
counsel can sign off on the wording BEFORE Phase 5 ships the wizard UI.

## How to use

1. Chamber DPO reviews + signs off the three locale variants below
2. Chamber admin copies the relevant locale into the EventCreate event
   description (or links to a separate notice page)
3. Phase 5 T080 admin wizard embeds these snippets with one-click
   copy-to-clipboard
4. Quarterly DPO review re-validates the wording against PDPA / GDPR
   updates

---

## Template (English)

> ### Personal Data Notice
>
> By registering for this event, you acknowledge that **[Chamber Name]**
> (the "Chamber") will collect and process your personal data — including
> your name, email address, and company affiliation — for the following
> purposes:
>
> - **Event attendance recording**: Your registration is recorded in the
>   Chamber's membership-management system to track event participation
>   and apply chamber-member benefit allotments (e.g., partnership
>   event tickets, cultural event allotments).
> - **Member directory accuracy**: If you are an employee or
>   representative of a Chamber member organisation, your attendance is
>   linked to your member's record to support relationship management
>   and benefit accounting.
> - **Audit trail**: A record of your registration is retained for
>   compliance with the Chamber's governance obligations.
>
> **Data retention**:
>
> - If you are linked to a Chamber-member organisation, your data is
>   retained for **five (5) years** from the event date.
> - If you are a non-member attendee, identifying details are
>   **pseudonymised after two (2) years** (replaced with a one-way
>   cryptographic hash); aggregate attendance statistics are retained.
>
> **Your rights**:
>
> Under PDPA (Thailand) and / or GDPR (EU/EEA), you have the right to
> access, correct, erase, restrict processing of, port, or object to
> the processing of your personal data. To exercise these rights,
> contact the Chamber's Data Protection Officer at **[DPO email]**.
>
> **Lawful basis**: The Chamber processes your data under the
> "legitimate interest" basis (PDPA §24(5); GDPR Art. 6(1)(f)) — the
> Chamber's interest in maintaining accurate records of its events
> and member engagement, balanced against your reasonable expectation
> of privacy.
>
> **Cross-border transfer**: Your data is stored on cloud infrastructure
> located in **Singapore** (Vercel and Neon). The Chamber's processor
> (Chamber-OS) has signed appropriate contractual safeguards (PDPA §28;
> GDPR Standard Contractual Clauses) covering this transfer.
>
> **Data processors and transit**:
>
> Your registration data flows through the following processors before
> reaching the Chamber's systems:
>
> - **EventCreate** (event registration platform — United States) — the
>   event organiser, where you submit your registration.
> - **Zapier** (automation service — United States) — transmits your
>   registration record from EventCreate to Chamber-OS in near real-time
>   (typically within 15 minutes of registration). Zapier is a temporary
>   data conduit; no long-term retention occurs at the Zapier layer.
> - **Chamber-OS** (Chamber's membership-management system — Singapore
>   region) — persists your registration record under the retention
>   policy stated above.
>
> The Chamber has signed contractual safeguards (PDPA §28 cross-border
> consent; GDPR Standard Contractual Clauses + adequacy assessments)
> for the EU-US and Thailand-US data flows via EventCreate and Zapier.
>
> For the full Chamber privacy policy, see **[Chamber privacy policy URL]**.

---

## Template (Thai / ภาษาไทย)

> ### หนังสือแจ้งการเก็บข้อมูลส่วนบุคคล
>
> เมื่อท่านลงทะเบียนเข้าร่วมงานนี้ ท่านรับทราบว่า **[ชื่อหอการค้า]**
> (ต่อไปนี้เรียกว่า "หอการค้า") จะเก็บรวบรวมและประมวลผลข้อมูลส่วนบุคคล
> ของท่าน — รวมถึงชื่อ-นามสกุล อีเมล และบริษัทต้นสังกัด — เพื่อ
> วัตถุประสงค์ต่อไปนี้:
>
> - **การบันทึกการเข้าร่วมงาน**: การลงทะเบียนของท่านจะถูกบันทึกใน
>   ระบบจัดการสมาชิกของหอการค้า เพื่อติดตามการเข้าร่วมงานและจัดสรร
>   สิทธิประโยชน์สมาชิกหอการค้า (เช่น จำนวนสิทธิการเข้าร่วมงาน
>   Partnership หรือกิจกรรมด้านวัฒนธรรม)
> - **ความถูกต้องของทำเนียบสมาชิก**: หากท่านเป็นพนักงานหรือตัวแทน
>   ขององค์กรสมาชิกของหอการค้า การเข้าร่วมของท่านจะถูกเชื่อมโยงกับ
>   บันทึกสมาชิกของท่านเพื่อสนับสนุนการบริหารความสัมพันธ์และการ
>   คำนวณสิทธิประโยชน์
> - **บันทึกการตรวจสอบ**: บันทึกการลงทะเบียนของท่านจะถูกเก็บไว้
>   ตามภาระผูกพันด้านธรรมาภิบาลของหอการค้า
>
> **ระยะเวลาเก็บข้อมูล**:
>
> - หากท่านเชื่อมโยงกับองค์กรสมาชิกหอการค้า ข้อมูลของท่านจะถูกเก็บไว้
>   เป็นเวลา **ห้า (5) ปี** นับจากวันที่งาน
> - หากท่านเป็นผู้เข้าร่วมที่ไม่ใช่สมาชิก ข้อมูลที่ระบุตัวตนจะ
>   **ถูกทำให้นิรนาม (pseudonymised) หลังจาก สอง (2) ปี** (แทนที่ด้วย
>   hash การเข้ารหัสแบบทางเดียว) สถิติการเข้าร่วมโดยรวมยังคงเก็บไว้
>
> **สิทธิของท่าน**:
>
> ภายใต้ พ.ร.บ. คุ้มครองข้อมูลส่วนบุคคล (PDPA) ของประเทศไทย และ/หรือ
> GDPR ของสหภาพยุโรป ท่านมีสิทธิเข้าถึง แก้ไข ลบ จำกัดการประมวลผล
> รับโอนข้อมูล หรือคัดค้านการประมวลผลข้อมูลส่วนบุคคลของท่าน
> หากต้องการใช้สิทธิเหล่านี้ กรุณาติดต่อเจ้าหน้าที่คุ้มครองข้อมูล
> ส่วนบุคคลของหอการค้าที่ **[DPO email]**
>
> **ฐานทางกฎหมาย**: หอการค้าประมวลผลข้อมูลของท่านโดยอาศัยฐาน
> "ประโยชน์โดยชอบด้วยกฎหมาย" (PDPA §24(5); GDPR Art. 6(1)(f)) — เพื่อ
> ประโยชน์ของหอการค้าในการรักษาบันทึกการจัดงานและการมีส่วนร่วมของ
> สมาชิกอย่างถูกต้อง โดยคำนึงถึงความคาดหวังที่สมเหตุสมผลในความเป็น
> ส่วนตัวของท่าน
>
> **การโอนข้อมูลข้ามพรมแดน**: ข้อมูลของท่านจะถูกจัดเก็บบนโครงสร้าง
> พื้นฐานคลาวด์ที่ตั้งอยู่ใน **ประเทศสิงคโปร์** (Vercel และ Neon)
> ผู้ประมวลผลของหอการค้า (Chamber-OS) ได้ลงนามในข้อกำหนดสัญญาที่
> เหมาะสม (PDPA §28; GDPR Standard Contractual Clauses) เพื่อ
> ครอบคลุมการโอนข้อมูลนี้
>
> **ผู้ประมวลผลและการส่งผ่านข้อมูล**:
>
> ข้อมูลการลงทะเบียนของท่านจะผ่านผู้ประมวลผลต่อไปนี้ก่อนเข้าสู่ระบบ
> ของหอการค้า:
>
> - **EventCreate** (แพลตฟอร์มลงทะเบียนงาน — ประเทศสหรัฐอเมริกา) —
>   ผู้จัดงาน ซึ่งเป็นจุดที่ท่านส่งข้อมูลการลงทะเบียน
> - **Zapier** (บริการอัตโนมัติ — ประเทศสหรัฐอเมริกา) — ส่งข้อมูล
>   การลงทะเบียนของท่านจาก EventCreate ไปยัง Chamber-OS แบบ
>   เกือบเรียลไทม์ (โดยปกติภายใน 15 นาทีหลังการลงทะเบียน) Zapier
>   เป็นช่องทางส่งผ่านข้อมูลชั่วคราว ไม่มีการเก็บรักษาข้อมูลระยะยาว
>   ที่ชั้น Zapier
> - **Chamber-OS** (ระบบจัดการสมาชิกของหอการค้า — ภูมิภาคสิงคโปร์)
>   — จัดเก็บข้อมูลการลงทะเบียนของท่านตามนโยบายการเก็บข้อมูลข้างต้น
>
> หอการค้าได้ลงนามในข้อกำหนดสัญญาเชิงป้องกันที่เหมาะสม (PDPA §28
> ความยินยอมการส่งข้อมูลข้ามพรมแดน; GDPR Standard Contractual
> Clauses + การประเมินความเพียงพอ) สำหรับการส่งข้อมูล EU-US และ
> ไทย-US ผ่าน EventCreate และ Zapier
>
> สำหรับนโยบายความเป็นส่วนตัวฉบับเต็มของหอการค้า โปรดดู **[Chamber
> privacy policy URL]**

---

## Template (Swedish / Svenska)

> ### Information om personuppgiftsbehandling
>
> Genom att registrera dig till detta evenemang bekräftar du att
> **[Handelskammarens namn]** ("Handelskammaren") kommer att samla in
> och behandla dina personuppgifter — inklusive namn, e-postadress och
> företagstillhörighet — för följande ändamål:
>
> - **Registrering av evenemangsdeltagande**: Din anmälan registreras
>   i Handelskammarens medlemshanteringssystem för att följa
>   deltagande och tillämpa medlemsförmåner (t.ex. Partnership-biljetter,
>   kulturarrangemangstilldelningar).
> - **Noggrannhet i medlemsregistret**: Om du är anställd eller
>   representant för en medlemsorganisation kopplas ditt deltagande
>   till din medlemspost för att stödja relationshantering och
>   förmånsadministration.
> - **Granskningsspår**: En registrering av din anmälan bevaras i
>   enlighet med Handelskammarens styrningsskyldigheter.
>
> **Lagringstid**:
>
> - Om du är kopplad till en medlemsorganisation bevaras dina
>   uppgifter i **fem (5) år** från evenemangsdatumet.
> - Om du är en icke-medlem-deltagare **pseudonymiseras** identifierande
>   uppgifter **efter två (2) år** (ersätts med en envägs-kryptografisk
>   hash); aggregerad deltagandestatistik behålls.
>
> **Dina rättigheter**:
>
> Enligt PDPA (Thailand) och/eller GDPR (EU/EES) har du rätt att få
> tillgång till, rätta, radera, begränsa behandlingen av, överföra eller
> invända mot behandlingen av dina personuppgifter. För att utöva
> dessa rättigheter, kontakta Handelskammarens dataskyddsombud på
> **[DPO email]**.
>
> **Rättslig grund**: Handelskammaren behandlar dina uppgifter på
> grunden "berättigat intresse" (PDPA §24(5); GDPR art. 6.1 f) —
> Handelskammarens intresse av att upprätthålla korrekta register
> över sina evenemang och medlemsengagemang, vägt mot din rimliga
> förväntan på integritet.
>
> **Överföring till tredje land**: Dina uppgifter lagras på
> molninfrastruktur i **Singapore** (Vercel och Neon).
> Handelskammarens databehandlare (Chamber-OS) har undertecknat
> lämpliga avtalsmässiga skyddsåtgärder (PDPA §28; GDPR Standard
> Contractual Clauses) som omfattar denna överföring.
>
> **Personuppgiftsbiträden och dataflöde**:
>
> Dina registreringsuppgifter passerar följande databehandlare innan
> de når Handelskammarens system:
>
> - **EventCreate** (registreringsplattform — USA) — evenemangs-
>   arrangören, där du skickar in din registrering.
> - **Zapier** (automatiseringstjänst — USA) — överför din
>   registreringspost från EventCreate till Chamber-OS nästan i
>   realtid (vanligtvis inom 15 minuter efter registrering). Zapier
>   är en tillfällig dataförmedlare; ingen långsiktig lagring sker
>   på Zapier-nivå.
> - **Chamber-OS** (Handelskammarens medlemshanteringssystem —
>   Singapore-regionen) — bevarar din registreringspost enligt den
>   bevarandepolicy som anges ovan.
>
> Handelskammaren har undertecknat avtalsmässiga skyddsåtgärder
> (PDPA §28 samtycke till gränsöverskridande överföring; GDPR
> Standard Contractual Clauses + adekvansbedömningar) för data-
> flödena EU-USA och Thailand-USA via EventCreate och Zapier.
>
> Se Handelskammarens fullständiga integritetspolicy på
> **[Chamber privacy policy URL]**.

---

## Approval log

| Date | Reviewer | Action |
|---|---|---|
| 2026-05-12 | (pending) Chamber DPO | Initial review |
| (pending) | Chamber legal counsel | EN + TH + SV wording sign-off |

## Phase 5 wiring plan

When Phase 5 T080 wizard ships:

1. Embed each locale template as a `<pre>` block with copy-to-clipboard button
2. Display the `[Chamber Name]`, `[DPO email]`, `[Chamber privacy policy URL]`
   placeholders as form-filled values from tenant settings
3. Add a "Mark as deployed" checkbox that records the chamber's
   confirmation that the notice IS live on the EventCreate event page
   (audit-trail row in `audit_log` with new event type to be added by
   Phase 5 — TBD between `wizard_privacy_notice_acknowledged` or similar)
4. Quarterly cron reminder to chamber admin if the deploy is never marked

## Related documents

- `docs/compliance/processing-records.md` § F6 EventCreate Integration
- `docs/runbooks/f6-manual-erasure.md`
- F6 spec.md Assumptions § Privacy + compliance posture
- specs/012-eventcreate-integration/plan.md § Compliance: Hosting & Residency
