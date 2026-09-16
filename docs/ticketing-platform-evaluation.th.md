# การประเมินแพลตฟอร์มขายบัตร/ลงทะเบียนงานอีเวนต์ (ฉบับภาษาไทย)

**วันที่ประเมิน**: 2026-08-06
**สถานะ**: รอนำเสนอบอร์ด TSCC
**เกี่ยวข้องกับ**: F6 EventCreate Integration (`docs/event-integration-analysis.md`)
**ฉบับภาษาอังกฤษสำหรับนำเสนอบอร์ด**: https://claude.ai/code/artifact/f15fc569-3895-4be2-962c-92a206b10ec7

> เอกสารนี้เขียนเป็นภาษาไทยโดยตั้งใจ เพราะเป็นเอกสารประกอบการตัดสินใจภายใน
> เอกสารเชิงเทคนิคอื่นในโปรเจกต์ยังคงเป็นภาษาอังกฤษตาม CLAUDE.md

---

## 1. บทสรุป

**Ticket Tailor คือตัวเลือกที่ดีที่สุด** ในบรรดา 6 แพลตฟอร์มที่ประเมิน — ภายใต้เงื่อนไข 2 ข้อที่ผู้บริหารตัดสินใจแล้ว:

1. หน้าซื้อบัตร **ไม่จำเป็นต้องมีภาษาไทย** (มีอังกฤษ + สวีเดน)
2. **เงินค่าบัตรแยกจากระบบใบกำกับภาษี (F4/F5) ได้** — เข้า Stripe ของหอการค้าโดยตรง

**ถ้าเงื่อนไขข้อ 1 เปลี่ยน** (ต้องมีภาษาไทย) ตัวสำรองอันดับ 1 คือ **Eventpop** ไม่ใช่ EventCreate

---

## 2. ทำไมต้องหาตัวใหม่

EventCreate ขายบัตรและรับลงทะเบียนได้ดี ปัญหาอยู่ที่ "หลังงานจบ":

| ประเด็น | สภาพปัจจุบัน |
|---|---|
| การนำข้อมูลเข้าระบบ | export Excel แล้วพิมพ์เข้าระบบด้วยมือ |
| ผลที่ตามมา | สิทธิประโยชน์ที่สมาชิก**จ่ายเงินซื้อ** (ตั๋วฟรี Partnership, โควตางานวัฒนธรรม) นับด้วยมือ หรือไม่ได้นับเลย |
| สาเหตุราก | EventCreate **ไม่มี public API และไม่มี webhook** — ทางเดียวคือผ่าน Zapier ซึ่งดีเลย์ 15 นาที |

นี่คือช่องว่างระหว่าง "สิ่งที่สมาชิกจ่ายเงินซื้อ" กับ "สิ่งที่หอการค้าพิสูจน์ได้ว่าสมาชิกได้รับ"

---

## 3. ตัวเลือกที่ประเมิน

| แพลตฟอร์ม | THB | เชื่อมระบบเรา | ผลประเมิน |
|---|---|---|---|
| **Ticket Tailor** | ✅ | ✅ API + webhook | **แนะนำ** — มีทั้ง push (webhook) และ pull (API สำหรับ backfill/reconcile) |
| Eventpop | ✅ | ⚠️ API แต่**ไม่มี webhook** | ตัวสำรองอันดับ 1 — ไทยแท้, PromptPay ในตัว (Opn/Omise), ต้อง poll ด้วย Vercel Cron |
| Zipevent / Ticketmelon | ✅ | ❌ ไม่มีเอกสาร public | ต้องใช้ CSV import — ไม่ต่างจากปัจจุบัน |
| Eventbrite | ❌ | ✅ | **ตกที่เรื่องเงิน** — ไทยไม่อยู่ในประเทศที่รับ payout ได้ (ARS/AUD/EUR/BRL/CAD/USD/MXN/NZD/HKD/GBP เท่านั้น) |
| Luma | ⚠️ ไม่ยืนยัน | ⚠️ จำกัด | เอกสารระบุ USD/CAD/EUR/GBP — ไม่เดินต่อ |
| Glue Up | ✅ | ✅ | **เป็นคู่แข่ง ไม่ใช่ส่วนประกอบ** — แทน membership + event + finance ทั้งก้อน ราคา $3,000–18,500/ปี |

---

## 4. ผลทดสอบ API จริง (ไม่ใช่อ่านจากโบรชัวร์)

ต่อ API จริงด้วยบัญชีทดสอบของ TSCC เมื่อ 2026-08-06 — สร้าง event series + occurrence + ticket type ราคา ฿1,500 + ออกตั๋ว 1 ใบ → ตรวจ payload → **ลบทิ้งทั้งหมด** (ยืนยันเหลือ 0 รายการทุกตาราง)

### 4.1 สิ่งที่ยืนยันได้

| ประเด็น | ผลจริง |
|---|---|
| **THB** | ตั้งได้จริง — แต่ default เป็น `usd` ต้องเปลี่ยนเอง |
| **หน่วยเงิน** | สตางค์ (minor units) — `price: 150000` = ฿1,500.00 |
| **ตัวคูณ** | ทุก payload แนบ `listed_currency: {code:"thb", base_multiplier:100}` มาให้ → **ไม่ต้อง hardcode** |
| **Timezone** | บัญชีตั้ง `Asia/Bangkok` แล้ว; event คืนทั้ง `iso` (`2026-09-15T18:00:00+07:00`) และ `unix` → เก็บ UTC ได้ตรง convention |
| **เส้นทางเงิน** | เข้า Stripe ของหอการค้าโดยตรง — Ticket Tailor เป็น PCI DSS SAQ-A Level 1 service provider ใช้ Stripe Payment Element ⇒ **ข้อมูลบัตรไม่แตะ server เรา** ไม่กระทบ Principle IV |
| **บัญชี** | slug = `tscc` (`buytickets.at/tscc`) |

### 4.2 โครงสร้าง `issued_ticket` (payload จริง)

```
id (it_)  ·  email  ·  full_name  ·  first_name  ·  last_name  ·  custom_questions[]
listed_price  ·  listed_currency{code, base_multiplier}  ·  status(valid)  ·  voided_at  ·  checked_in
event_id  ·  event_series_id  ·  ticket_type_id  ·  order_id  ·  source("api")
barcode  ·  qr_code_url  ·  created_at / updated_at (unix)
```

**⚠️ ข้อสำคัญที่สุดสำหรับ F6**: **ไม่มี field "ชื่อบริษัท" มาตรฐาน** — ต้องมาจาก `custom_questions` ซึ่ง**สร้างผ่าน API ไม่ได้** (`POST /v1/checkout_forms/{id}/elements` → 404) ต้องตั้งใน UI

ผลกระทบต่อ matching algorithm ของ F6 (`docs/event-integration-analysis.md` § 6):

| Rule | ใช้ได้ไหม |
|---|---|
| 1. exact contact email match | ✅ ใช้ได้ทันที (`email`) |
| 2. email domain match | ✅ ใช้ได้ทันที |
| 3. company name fuzzy match | ❌ **ตายทั้งรูล** ถ้าไม่ตั้ง custom question "Company" |
| 4. no match → `non_member` | ✅ |

### 4.3 Webhook

| ประเด็น | รายละเอียด |
|---|---|
| Event types | `order.created/updated` · `issued_ticket.created/updated` · `event.created/updated/deleted` · `waitlist_signup.created` |
| Header | `Tickettailor-Webhook-Signature` รูปแบบ `t=<timestamp>,s=<signature>` |
| Algorithm | HMAC-SHA256 ของ `timestamp + body`, constant-time compare, แนะนำปฏิเสธถ้า timestamp เก่ากว่า 5 นาที |
| **เทียบกับ F6 ของเรา** | `message = ${timestamp}.${body}`, skew 300s → **ต่างแค่ตัวคั่นกับชื่อ header** โค้ด verify reuse ได้เกือบทั้งหมด |
| Retry | 22 ครั้งใน 72 ชม. (exponential backoff); ล้มเหลวต่อเนื่อง 5 วัน → เตือนทางอีเมล, 10 วัน → ปิด webhook ต้องเปิดเอง |
| Idempotency | จำเป็น — เรามีอยู่แล้ว (request ID + Upstash TTL 7 วัน) |

### 4.4 API quirks ที่เอกสารไม่บอก (จะเสียเวลาถ้าไม่รู้)

- **update ใช้ `POST /v1/{resource}/{id}`** — `PUT` และ `PATCH` คืน 404 ทั้งคู่
- form-encoded ไม่ใช่ JSON
- วันที่ format `Y-m-d`, เวลา `H:i:s` (ส่ง `18:00` ไม่ผ่าน ต้อง `18:00:00`)
- validation error บอกทีละ field เท่านั้น — ต้องยิงหลายรอบกว่าจะครบ แต่ message ชัดเจน
- id prefix แบบ Stripe: `es_` `ev_` `tt_` `it_` `cf_`
- auth = HTTP Basic (API key เป็น username, password ว่าง) — generate เองได้ ไม่ต้องขออนุมัติ partner
- rate limit 5,000 req/30 นาที · cursor pagination (`starting_after`/`ending_before`) สูงสุด 100/หน้า
- มี **official MCP server** (`developers.tickettailor.com/docs/mcp/`)

---

## 5. เทียบฟีเจอร์กับ EventCreate

| ฟีเจอร์ | Ticket Tailor | EventCreate |
|---|---|---|
| การเชื่อมระบบ | **API + native webhook** | Zapier เท่านั้น (ดีเลย์ 15 นาที) |
| Check-in | app ฟรี iOS/Android, **ทำงาน offline**, ต่อ scanner ภายนอก, Tap-to-Pay | มี attendee app |
| **จ่ายแบบโอน/บิล/หน้างาน** | มี + ติดตามว่าใครจ่ายแล้ว (endpoint `confirm-payment-recieved`) | ไม่ชัด |
| ที่นั่ง / รอบเวลา | reserved seating + time-slot/recurring | จำกัดกว่า |
| ทีมงาน | **ไม่จำกัด ฟรี** | ตามแพ็กเกจ |
| **ภาษาหน้าซื้อบัตร** | 19 ภาษา แต่ **1 box office = 1 ภาษา**; มี `sv` **ไม่มี `th`** | หลายภาษา ✅ |
| อื่นๆ | widget ฝังเว็บ (มีคู่มือ CSP), Apple Wallet, waitlist, discount/voucher, SMS/WhatsApp, GA/Meta pixel, white-label (มีค่าธรรมเนียม) | landing page, WYSIWYG, affiliate tracking |
| ราคา | ~$0.85/ตั๋ว (เครดิตล่วงหน้า ~$0.30) · **งานฟรี = ฟรีถึง 5,000 ตั๋ว/ปี** · ไม่หัก % จากยอดขาย | ตามแพ็กเกจรายปี (ต้องเช็คยอดจริงกับฝ่ายการเงิน) |

---

## 6. ข้อจำกัดที่ยอมรับแล้ว

| ข้อจำกัด | เหตุผลที่ยอมรับ |
|---|---|
| **ไม่มีภาษาไทยบนหน้าซื้อบัตร** | งานของหอการค้าใช้ภาษาอังกฤษเป็นหลัก — ผู้บริหารตัดสินใจแล้ว (2026-08-06); Ticket Tailor เปิดรับคำขอเพิ่มภาษา |
| **เงินค่าบัตรไม่ผ่าน F4/F5** | เข้า Stripe โดยตรง ไม่ออกใบกำกับภาษีจากระบบเรา — **EventCreate ทุกวันนี้ก็เป็นแบบนี้อยู่แล้ว** ไม่ได้สร้างช่องว่างใหม่ |
| **1 box office = 1 ภาษา** | ตั้งที่ Box office settings ไม่ใช่ต่องาน และผู้ซื้อเลือกเองไม่ได้ — workaround คือแยกหลาย box office (1 Stripe เชื่อมได้หลาย box office) แต่ API key ผูกต่อ box office |

---

## 7. สิ่งที่ยังไม่ยืนยัน (4 ข้อ)

ทั้ง 4 ข้อต้องมี payment gateway หรือทำใน UI จึงทดสอบได้ — **ไม่กระทบข้อสรุป** และจะรู้ผลจบภายในงาน pilot งานเดียว

1. **PromptPay** โผล่ใน Payment Element หรือไม่ (Stripe ไทยรองรับ แต่ต้องดูว่า Ticket Tailor เปิดให้)
2. **VAT 7%** ตั้งได้จริงและแสดงบนหน้าจ่ายเงินถูกต้อง (ส่งผ่าน API แล้วไม่ถูกบันทึก)
3. **โครงสร้าง `order`** — ต้องมีการซื้อจริง 1 ครั้ง
4. **webhook signature จริง** — ต้องตั้ง webhook + มี public URL

**ทางถอยถ้า PromptPay ไม่มี**: ยังไม่ล้ม — ใช้บัตรเครดิต + โอนเงิน (offline payment ที่ติดตามสถานะได้ในระบบ) ซึ่งเป็นวิธีที่หอการค้าไทยใช้กันอยู่แล้ว

---

## 8. คู่มือตั้งค่าใน UI (สิ่งที่ต้องทำเอง — API ทำแทนไม่ได้)

| ตั้งอะไร | อยู่ตรงไหน | หมายเหตุ |
|---|---|---|
| **Rotate API key** | Settings → API | **ทำก่อนเลย** — key ที่ใช้ทดสอบผ่านช่องแชทมาแล้ว |
| **Currency = THB** | Events → เลือกงาน → **Edit event and tickets** → **Event settings** → Currency | ตั้ง**ต่องาน** ไม่ใช่ box office; งานที่ Live อยู่ต้องเปลี่ยนกลับเป็น **Draft** ก่อน; ตะกร้าเดียวรวมข้ามสกุลไม่ได้ ⇒ ทุกงานควรใช้สกุลเดียวกัน |
| **VAT 7%** | **Box office settings** → **Checkout fees and tax** | เลือก *exclusive* (บวกจากราคา) หรือ *inclusive* (ราคารวมแล้ว) + ใส่ % และ label "VAT"; ตั้งต่อ ticket type ไม่ได้ |
| **Language** | **Box office settings** → **Basic settings** → Language | ตั้งครั้งเดียวทั้ง box office |
| **Stripe บัญชีไทย** | Settings → Payment | เช็คว่า PromptPay โผล่ใน Payment Element ไหม |
| **คำถาม "Company"** | Checkout form ของทุกงาน | **จำเป็น** — ไม่มีข้อนี้ matching rule 3 ใช้ไม่ได้ |

---

## 9. แผนงานถัดไป

| ขั้น | ทำอะไร | ใคร | เวลา |
|---|---|---|---|
| 1 | ตั้งค่า box office ตามตาราง § 8 | ทีมหอการค้า | ~ครึ่งวัน |
| 2 | **จัดงาน pilot 1 งานจริง** — ปิด 4 ข้อใน § 7 ให้จบ | ทีมหอการค้า | งานถัดไป |
| 3 | เขียน **adapter ตัวที่ 2 ของ F6** (webhook receiver + backfill ผ่าน API + matching + quota) เก็บ CSV import ไว้เป็น fallback | dev | ~1–2 สัปดาห์หลัง pilot |
| 4 | ย้ายงานที่เหลือ + ยกเลิก EventCreate ตอนครบรอบ | ทีมหอการค้า | รอบต่ออายุ |

### หมายเหตุด้านสถาปัตยกรรม

F6 ออกแบบรองรับหลาย source ไว้แล้ว — `events.source` (default `'eventcreate'`, comment ระบุ "future: other sources") และ `tenant_webhook_configs.source` ⇒ **เพิ่ม Ticket Tailor = เขียน adapter ใหม่ ไม่ต้องแก้ schema**

---

## 10. อ้างอิง

- [Ticket Tailor API docs](https://developers.tickettailor.com/docs/api/ticket-tailor-api/) · [Webhook configuration](https://developers.tickettailor.com/docs/webhook/configuration/) · [Webhook security](https://developers.tickettailor.com/docs/webhook/security/) · [Webhook retry](https://developers.tickettailor.com/docs/webhook/retry/) · [MCP](https://developers.tickettailor.com/docs/mcp/)
- [รายการสกุลเงินที่รองรับ](https://help.tickettailor.com/en/articles/9071904-what-currencies-can-i-accept) · [เปลี่ยน currency ของงาน](https://help.tickettailor.com/en/articles/950004-how-do-i-edit-the-currency-for-my-event) · [ตั้ง VAT](https://help.tickettailor.com/en/articles/1549496-where-can-i-add-sales-tax-vat-to-my-tickets) · [แปลหน้า event](https://help.tickettailor.com/en/articles/6062917-can-you-translate-my-event-page)
- [ราคา Ticket Tailor](https://www.tickettailor.com/pricing) · [Sell tickets with Stripe](https://www.tickettailor.com/features/sell-tickets-with-stripe) · [Stripe ประเทศไทย — payout](https://support.stripe.com/questions/payout-schedule-and-currency-for-stripe-accounts-in-thailand)
- [Eventpop API](https://docs.eventpop.me/) · [Eventbrite payment processing](https://www.eventbrite.com/help/en-us/articles/705340/comparing-payment-processing-options/) · [Glue Up open API v2](https://support.glueup.com/hc/en-us/articles/46960548123673-Glue-Up-open-API-v2)
- เอกสารในโปรเจกต์: `docs/event-integration-analysis.md` (F6), `docs/saas-architecture.md`
