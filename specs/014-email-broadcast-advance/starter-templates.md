# Starter Templates — F7.1a US7 (FR-020)

**Purpose**: Content source for migration `0134_f71a_default_template_seed.sql`. Seeds **5 starter templates × 3 locales = 15 rows per tenant** at F7.1a ship time. Admins can edit/delete post-ship.

**Audit signal on conflict**: If a tenant already has a template with the same name (case-insensitive), the seed step SKIPs that row and emits `broadcast_template_seed_skipped_existing_name` (FR-020 / data-model § 7).

**Sanitization**: All template `body_html` values below are pre-validated against F7 MVP allowed tags (`p`, `h2`, `h3`, `ul`, `li`, `strong`, `a[href]`) + F7 MVP allowed `a[href]` schemes (http/https/mailto). NO `<img>` tags in starters — members add their own images via US2 inline upload + tenant allowlist.

**Placeholders (post critique E1 / X1 / P5 — 2026-05-18)**:
- **`{{chamber_name}}`** — the ONLY server-substituted variable. Resolved at `snapshotTemplateToDraft` time per `contracts/broadcast-template.md § 5`. Value comes from `tenants.display_name`, HTML-escaped before substitution.
- **`[bracketed text]`** — member-editable placeholders rendered as visible bracket text in the editor (members replace with actual content). All previously-defined variables (`{{ member_name }}`, `{{ event_name }}`, `{{ month_year }}`, `{{ featured_company_name }}`, `{{ spokesperson_name }}`, `{{ spokesperson_title }}` — spaces added in this doc note ONLY to avoid the renaming script; actual templates use the bracket form) were CONVERTED to bracket placeholders on 2026-05-18 per critique findings X1 + P5 — broadcasts dispatch to segments of 5,000-50,000 recipients, NOT to single members, so per-recipient variable substitution is incoherent with F7 MVP's Broadcasts-audience model. The member composing the broadcast fills in the bracket text once (at compose time) → text ships verbatim to all recipients.

**Compliance review note**: Templates ship as-authored by the maintainer (2026-05-18). Chamber compliance liaison may refine tone/legal phrasing post-ship via the admin template-edit UI (FR-016) — no migration needed.

---

## Template 1: Monthly Newsletter

### EN

**Name**: `Monthly Newsletter`
**Subject**: `{{chamber_name}} Monthly Newsletter — [Month YYYY]`

**Body HTML**:
```html
<h2>{{chamber_name}} Monthly Newsletter — [Month YYYY]</h2>
<p>Dear members,</p>
<p>Welcome to this month's chamber newsletter. Here's what's happening in our community:</p>
<h3>This month's highlights</h3>
<ul>
  <li>[Add highlight 1]</li>
  <li>[Add highlight 2]</li>
  <li>[Add highlight 3]</li>
</ul>
<h3>Upcoming events</h3>
<p>[Add upcoming events or link to events page]</p>
<p>Best regards,<br><strong>{{chamber_name}} Team</strong></p>
```

### TH

**Name**: `จดหมายข่าวประจำเดือน`
**Subject**: `จดหมายข่าวประจำเดือน {{chamber_name}} — [เดือน พ.ศ. YYYY]`

**Body HTML**:
```html
<h2>จดหมายข่าวประจำเดือน {{chamber_name}} — [เดือน พ.ศ. YYYY]</h2>
<p>เรียน สมาชิกทุกท่าน</p>
<p>ขอต้อนรับสู่จดหมายข่าวประจำเดือนของหอการค้า ในเดือนนี้มีข่าวสารดังนี้:</p>
<h3>ไฮไลท์ประจำเดือน</h3>
<ul>
  <li>[เพิ่มไฮไลท์ที่ 1]</li>
  <li>[เพิ่มไฮไลท์ที่ 2]</li>
  <li>[เพิ่มไฮไลท์ที่ 3]</li>
</ul>
<h3>กิจกรรมที่จะมาถึง</h3>
<p>[เพิ่มข้อมูลกิจกรรมหรือลิงก์ไปที่หน้ากิจกรรม]</p>
<p>ขอแสดงความนับถือ<br><strong>ทีมงาน {{chamber_name}}</strong></p>
```

### SV

**Name**: `Månadsbrev`
**Subject**: `{{chamber_name}} Månadsbrev — [Månad ÅÅÅÅ]`

**Body HTML**:
```html
<h2>{{chamber_name}} Månadsbrev — [Månad ÅÅÅÅ]</h2>
<p>Bästa medlemmar,</p>
<p>Välkomna till månadens nyhetsbrev. Här är vad som händer i vårt nätverk:</p>
<h3>Månadens höjdpunkter</h3>
<ul>
  <li>[Lägg till höjdpunkt 1]</li>
  <li>[Lägg till höjdpunkt 2]</li>
  <li>[Lägg till höjdpunkt 3]</li>
</ul>
<h3>Kommande evenemang</h3>
<p>[Lägg till kommande evenemang eller länk till evenemangssidan]</p>
<p>Med vänliga hälsningar,<br><strong>{{chamber_name}}s team</strong></p>
```

---

## Template 2: Event Invitation

### EN

**Name**: `Event Invitation`
**Subject**: `You're invited: [event name]`

**Body HTML**:
```html
<h2>You're invited: [event name]</h2>
<p>Dear members,</p>
<p><strong>{{chamber_name}}</strong> is pleased to invite you to <strong>[event name]</strong>.</p>
<h3>Event details</h3>
<ul>
  <li><strong>Date:</strong> [date]</li>
  <li><strong>Time:</strong> [time]</li>
  <li><strong>Venue:</strong> [venue]</li>
  <li><strong>Dress code:</strong> [if applicable]</li>
</ul>
<p>[Brief event description — 2-3 sentences]</p>
<p>Please <a href="[rsvp_link]">RSVP here</a> by [deadline].</p>
<p>We look forward to seeing you!<br><strong>{{chamber_name}} Events Team</strong></p>
```

### TH

**Name**: `บัตรเชิญงาน`
**Subject**: `ขอเรียนเชิญ: [ชื่องาน]`

**Body HTML**:
```html
<h2>ขอเรียนเชิญ: [ชื่องาน]</h2>
<p>เรียน สมาชิกทุกท่าน</p>
<p><strong>{{chamber_name}}</strong> มีความยินดีขอเรียนเชิญท่านเข้าร่วม <strong>[ชื่องาน]</strong></p>
<h3>รายละเอียดงาน</h3>
<ul>
  <li><strong>วันที่:</strong> [วันที่]</li>
  <li><strong>เวลา:</strong> [เวลา]</li>
  <li><strong>สถานที่:</strong> [สถานที่]</li>
  <li><strong>การแต่งกาย:</strong> [ถ้ามี]</li>
</ul>
<p>[คำอธิบายงานสั้น ๆ — 2-3 ประโยค]</p>
<p>กรุณา <a href="[rsvp_link]">ตอบรับการเข้าร่วมที่นี่</a> ภายในวันที่ [deadline]</p>
<p>ขอขอบคุณและหวังว่าจะได้พบท่านในงาน<br><strong>ทีมจัดงาน {{chamber_name}}</strong></p>
```

### SV

**Name**: `Evenemangsinbjudan`
**Subject**: `Inbjudan: [evenemangets namn]`

**Body HTML**:
```html
<h2>Inbjudan: [evenemangets namn]</h2>
<p>Bästa medlemmar,</p>
<p><strong>{{chamber_name}}</strong> har glädjen att bjuda in er till <strong>[evenemangets namn]</strong>.</p>
<h3>Evenemangsdetaljer</h3>
<ul>
  <li><strong>Datum:</strong> [datum]</li>
  <li><strong>Tid:</strong> [tid]</li>
  <li><strong>Plats:</strong> [plats]</li>
  <li><strong>Klädkod:</strong> [om tillämpligt]</li>
</ul>
<p>[Kort evenemangsbeskrivning — 2-3 meningar]</p>
<p><a href="[rsvp_link]">OSA här</a> senast [datum].</p>
<p>Vi ser fram emot att träffa dig!<br><strong>{{chamber_name}}s evenemangsteam</strong></p>
```

---

## Template 3: Member Spotlight

### EN

**Name**: `Member Spotlight`
**Subject**: `Member Spotlight: [Company Name]`

**Body HTML**:
```html
<h2>Member Spotlight: [Company Name]</h2>
<p>This month we're proud to feature one of our valued members — <strong>[Company Name]</strong>.</p>
<h3>About [Company Name]</h3>
<p>[Add company introduction — 3-4 sentences covering industry, founding year, key services]</p>
<h3>Why they joined the chamber</h3>
<p>"[Add testimonial quote from member]" — [Spokesperson Name], [Title]</p>
<h3>Connect with them</h3>
<p>Visit <a href="[company_url]">[Company Name]</a> or reach out at <a href="mailto:[contact_email]">[contact_email]</a>.</p>
<p>Interested in being featured? Reply to this email.</p>
<p><strong>{{chamber_name}}</strong></p>
```

### TH

**Name**: `แนะนำสมาชิก`
**Subject**: `สมาชิกประจำเดือน: [ชื่อบริษัท]`

**Body HTML**:
```html
<h2>สมาชิกประจำเดือน: [ชื่อบริษัท]</h2>
<p>เดือนนี้เราขอแนะนำสมาชิกคนสำคัญของเรา — <strong>[ชื่อบริษัท]</strong></p>
<h3>เกี่ยวกับ [ชื่อบริษัท]</h3>
<p>[เพิ่มข้อมูลแนะนำบริษัท — 3-4 ประโยค ครอบคลุมอุตสาหกรรม ปีก่อตั้ง บริการหลัก]</p>
<h3>ทำไมจึงเลือกเข้าร่วมหอการค้า</h3>
<p>"[เพิ่มคำพูดของสมาชิก]" — คุณ[ชื่อผู้พูด], [ตำแหน่ง]</p>
<h3>ติดต่อกับสมาชิกท่านนี้</h3>
<p>เยี่ยมชม <a href="[company_url]">[ชื่อบริษัท]</a> หรือติดต่อที่ <a href="mailto:[contact_email]">[contact_email]</a></p>
<p>หากท่านสนใจให้หอการค้าแนะนำบริษัทของท่าน กรุณาตอบกลับอีเมลฉบับนี้</p>
<p><strong>{{chamber_name}}</strong></p>
```

### SV

**Name**: `Medlemspresentation`
**Subject**: `Medlemspresentation: [Företagsnamn]`

**Body HTML**:
```html
<h2>Medlemspresentation: [Företagsnamn]</h2>
<p>Den här månaden lyfter vi fram en av våra värdefulla medlemmar — <strong>[Företagsnamn]</strong>.</p>
<h3>Om [Företagsnamn]</h3>
<p>[Lägg till företagspresentation — 3-4 meningar om bransch, grundningsår, huvudtjänster]</p>
<h3>Varför de gick med i handelskammaren</h3>
<p>"[Lägg till citat från medlem]" — [Talespersonens namn], [Titel]</p>
<h3>Kontakta dem</h3>
<p>Besök <a href="[company_url]">[Företagsnamn]</a> eller kontakta <a href="mailto:[contact_email]">[contact_email]</a>.</p>
<p>Intresserad av att bli presenterad? Svara på detta mejl.</p>
<p><strong>{{chamber_name}}</strong></p>
```

---

## Template 4: Urgent Announcement

### EN

**Name**: `Urgent Announcement`
**Subject**: `Important: [Headline]`

**Body HTML**:
```html
<h2>Important: [Headline]</h2>
<p>Dear members,</p>
<p>[Lead with the key information — 1-2 sentences explaining what changed and why it matters]</p>
<h3>What this means for you</h3>
<ul>
  <li>[Action item 1 or impact 1]</li>
  <li>[Action item 2 or impact 2]</li>
</ul>
<h3>Action required by [deadline]</h3>
<p>[Specific action or link to next step]</p>
<p>If you have questions, contact us at <a href="mailto:[contact_email]">[contact_email]</a> or call [phone].</p>
<p><strong>{{chamber_name}}</strong></p>
```

### TH

**Name**: `ประกาศสำคัญ`
**Subject**: `ประกาศสำคัญ: [หัวข้อ]`

**Body HTML**:
```html
<h2>ประกาศสำคัญ: [หัวข้อ]</h2>
<p>เรียน สมาชิกทุกท่าน</p>
<p>[เริ่มต้นด้วยข้อมูลสำคัญ — 1-2 ประโยค อธิบายการเปลี่ยนแปลงและความสำคัญ]</p>
<h3>สิ่งที่ท่านต้องทราบ</h3>
<ul>
  <li>[ข้อปฏิบัติที่ 1 หรือผลกระทบที่ 1]</li>
  <li>[ข้อปฏิบัติที่ 2 หรือผลกระทบที่ 2]</li>
</ul>
<h3>กรุณาดำเนินการภายใน [วันที่]</h3>
<p>[ข้อปฏิบัติเฉพาะหรือลิงก์ไปขั้นตอนถัดไป]</p>
<p>หากมีข้อสงสัย กรุณาติดต่อ <a href="mailto:[contact_email]">[contact_email]</a> หรือโทร [เบอร์โทร]</p>
<p><strong>{{chamber_name}}</strong></p>
```

### SV

**Name**: `Brådskande meddelande`
**Subject**: `Viktigt: [Rubrik]`

**Body HTML**:
```html
<h2>Viktigt: [Rubrik]</h2>
<p>Bästa medlemmar,</p>
<p>[Inled med nyckelinformationen — 1-2 meningar som förklarar vad som ändrats och varför det är viktigt]</p>
<h3>Vad detta betyder för dig</h3>
<ul>
  <li>[Åtgärdspunkt 1 eller effekt 1]</li>
  <li>[Åtgärdspunkt 2 eller effekt 2]</li>
</ul>
<h3>Åtgärd krävs senast [datum]</h3>
<p>[Specifik åtgärd eller länk till nästa steg]</p>
<p>Om du har frågor, kontakta oss på <a href="mailto:[contact_email]">[contact_email]</a> eller ring [telefonnummer].</p>
<p><strong>{{chamber_name}}</strong></p>
```

---

## Template 5: Sponsorship Thank-You

### EN

**Name**: `Sponsorship Thank-You`
**Subject**: `Thank you to our 2026 sponsors`

**Body HTML**:
```html
<h2>Thank you to our 2026 sponsors</h2>
<p>Dear members,</p>
<p><strong>{{chamber_name}}</strong> is grateful to the companies that make our work possible through their generous sponsorship this year.</p>
<h3>Platinum sponsors</h3>
<p>[Logo grid or company list]</p>
<h3>Gold sponsors</h3>
<p>[Logo grid or company list]</p>
<h3>Silver sponsors</h3>
<p>[Logo grid or company list]</p>
<p>Their support enables us to deliver member events, networking opportunities, and chamber services throughout the year.</p>
<p>Interested in becoming a sponsor? Contact us at <a href="mailto:[sponsorship_email]">[sponsorship_email]</a>.</p>
<p>With appreciation,<br><strong>{{chamber_name}} Board</strong></p>
```

### TH

**Name**: `ขอบคุณผู้สนับสนุน`
**Subject**: `ขอขอบคุณผู้สนับสนุนประจำปี 2569`

**Body HTML**:
```html
<h2>ขอขอบคุณผู้สนับสนุนประจำปี 2569</h2>
<p>เรียน สมาชิกทุกท่าน</p>
<p><strong>{{chamber_name}}</strong> ขอขอบคุณบริษัทต่าง ๆ ที่สนับสนุนการดำเนินงานของหอการค้าในปีนี้ด้วยความเอื้อเฟื้อ</p>
<h3>ผู้สนับสนุนระดับแพลตินัม</h3>
<p>[โลโก้หรือรายชื่อบริษัท]</p>
<h3>ผู้สนับสนุนระดับทอง</h3>
<p>[โลโก้หรือรายชื่อบริษัท]</p>
<h3>ผู้สนับสนุนระดับเงิน</h3>
<p>[โลโก้หรือรายชื่อบริษัท]</p>
<p>การสนับสนุนของท่านช่วยให้เราสามารถจัดกิจกรรมสำหรับสมาชิก สร้างเครือข่าย และให้บริการต่าง ๆ ตลอดทั้งปี</p>
<p>หากสนใจเป็นผู้สนับสนุน กรุณาติดต่อ <a href="mailto:[sponsorship_email]">[sponsorship_email]</a></p>
<p>ด้วยความขอบคุณ<br><strong>คณะกรรมการ {{chamber_name}}</strong></p>
```

### SV

**Name**: `Sponsortack`
**Subject**: `Tack till våra sponsorer 2026`

**Body HTML**:
```html
<h2>Tack till våra sponsorer 2026</h2>
<p>Bästa medlemmar,</p>
<p><strong>{{chamber_name}}</strong> är tacksamma mot de företag som gör vårt arbete möjligt genom sitt generösa sponsorskap i år.</p>
<h3>Platinasponsorer</h3>
<p>[Logotypsamling eller företagslista]</p>
<h3>Guldsponsorer</h3>
<p>[Logotypsamling eller företagslista]</p>
<h3>Silversponsorer</h3>
<p>[Logotypsamling eller företagslista]</p>
<p>Deras stöd möjliggör medlemsevenemang, nätverksmöjligheter och kammartjänster under hela året.</p>
<p>Intresserad av att bli sponsor? Kontakta oss på <a href="mailto:[sponsorship_email]">[sponsorship_email]</a>.</p>
<p>Med uppskattning,<br><strong>{{chamber_name}}s styrelse</strong></p>
```

---

## Notes for migration 0134 (default-template-seed)

```sql
-- pseudocode for migration 0134_f71a_default_template_seed.sql
-- Executes per tenant via runInTenant(tenantId, () => { ... }) wrapper
-- Idempotent: skips templates whose (tenant_id, name, locale) already exists

WITH starter_templates AS (
  -- 5 templates × 3 locales = 15 rows
  -- Names, subjects, body_html as defined in this file
  -- is_seeded = TRUE, created_by_user_id = NULL
)
INSERT INTO broadcast_templates (id, tenant_id, name, subject, body_html, locale, is_seeded, created_at)
SELECT gen_random_uuid(), $1 /* tenantId */, name, subject, body_html, locale, TRUE, now()
FROM starter_templates
ON CONFLICT (tenant_id, name, locale) DO NOTHING
RETURNING id, name, locale;

-- Per skipped row, emit audit event broadcast_template_seed_skipped_existing_name
-- (handled in migration's PL/pgSQL block, NOT runtime use-case)
```

---

## Post-ship admin refinement workflow

1. Admin opens `/admin/broadcasts/templates`
2. Sees 5 seeded templates per locale (15 total) marked with "Starter" badge (`is_seeded = TRUE`)
3. Admin edits content (e.g., adjusts greeting, adds chamber-specific footer, replaces `[bracketed]` placeholders with real defaults)
4. Edit emits `broadcast_template_updated` audit event with before/after diff
5. `is_seeded` flag remains TRUE (forensic — chamber can always know which templates originated from F7.1a seed)
6. Admin can ALSO delete a starter template they don't use (emits `broadcast_template_deleted`)
