/**
 * F8 Phase 4 Wave I3 / T093-T098 + T114 — F8 reminder-email copy matrix.
 *
 * Co-located with the React Email templates per the F4 precedent
 * (`src/modules/invoicing/infrastructure/email/templates/copy.ts`).
 * Email-template strings are NOT tracked by `pnpm check:i18n` because
 * they live inside the F8 module rather than `src/i18n/messages/*.json`
 * — the i18n CI is for user-facing UI keys only. F8 enforces parity
 * via the unit test in `copy.test.ts` instead.
 *
 * Locale coverage (FR-013): EN canonical + TH + SV. Missing TH/SV
 * falls back to EN with a non-fatal dev warning + does NOT block
 * dispatch.
 *
 * Schedule policy → email-step coverage (data-model.md § 2.4):
 *   thai_alumni: T-30 · T-14 · T-3 · T+7
 *   start_up:    T-60 · T-30 · T-14 · T-7 · T+0 · T+7
 *   regular:     T-60 · T-30 · T-14 · T-7 · T+0 · T+7
 *   premium:     T-90 · T-60 · T-30 · T-14 · T-7 · T+0 · T+14
 *   partnership: T-120 · T-90 · T-30 · T-14 · T+0 · T+30
 *
 * Total = 30 distinct (tier × offset_day) email-step combinations.
 *
 * Copy interpolation placeholders (resolved by the gateway adapter):
 *   {firstName}        — primaryContact.firstName
 *   {companyName}      — member.companyName
 *   {tier}             — localized tier label (Thai Alumni, Start-up, …)
 *   {daysUntilExpiry}  — int (positive=before, negative=after)
 *   {expiresAt}        — formatted date (locale-aware)
 *
 * Templates use `{name}` syntax. The gateway uses a simple regex
 * replacement, NOT a full template engine — keeps the copy matrix
 * readable + the rendering path side-effect-free.
 */

export type RenewalEmailLocale = 'en' | 'th' | 'sv';

export const RENEWAL_REMINDER_TIERS = [
  'thai_alumni',
  'start_up',
  'regular',
  'premium',
  'partnership',
] as const;
export type RenewalReminderTier = (typeof RENEWAL_REMINDER_TIERS)[number];

export const RENEWAL_REMINDER_OFFSETS = [
  't-120',
  't-90',
  't-60',
  't-30',
  't-14',
  't-7',
  't-3',
  't+0',
  't+7',
  't+14',
  't+30',
] as const;
export type RenewalReminderOffset = (typeof RENEWAL_REMINDER_OFFSETS)[number];

export interface ReminderEmailCopy {
  /** Subject line (≤200 chars; placeholders interpolated by gateway). */
  readonly subject: string;
  /**
   * Body paragraph (plain text; React Email renders as `<Text>`).
   * For th locale, includes inline dual-format date per FR-014:
   * `"…หมดอายุในวันที่ {expiresAt}"` where `{expiresAt}` is dual-format.
   */
  readonly body: string;
  /** Primary CTA label (≤40 chars). */
  readonly cta: string;
}

/**
 * Per-tier label localization. Used by the body/subject interpolation
 * to resolve the `{tier}` placeholder into a human-readable string
 * matching the locale.
 *
 * J8-M29 decision: tier labels are kept in English across all 3
 * locales because they are SweCham brand-package names, NOT generic
 * descriptors. "Thai Alumni" / "Start-up" / "Premium" / "Partnership"
 * appear with the same English form on the chamber's marketing
 * collateral, contracts, and invoices — translating them in email
 * copy would create inconsistency with the printed-document trail.
 * Only the surrounding sentences are localized (TH/SV body copy in
 * the matrix below); the tier label itself stays as a brand mark.
 */
export const TIER_LABELS: Record<
  RenewalEmailLocale,
  Record<RenewalReminderTier, string>
> = {
  en: {
    thai_alumni: 'Thai Alumni',
    start_up: 'Start-up',
    regular: 'Regular',
    premium: 'Premium',
    partnership: 'Partnership',
  },
  th: {
    thai_alumni: 'Thai Alumni',
    start_up: 'Start-up',
    regular: 'Regular',
    premium: 'Premium',
    partnership: 'Partnership',
  },
  sv: {
    thai_alumni: 'Thai Alumni',
    start_up: 'Start-up',
    regular: 'Regular',
    premium: 'Premium',
    partnership: 'Partnership',
  },
};

type CopyKey = `${RenewalReminderTier}.${RenewalReminderOffset}`;

// English canonical copy. Templates have placeholders interpolated at
// render time. Keep ≤500 chars per body; subject ≤120 chars (Gmail).
/**
 * 065 §5.5 — the termination warning appended to every POST-expiry reminder
 * step (t+7/t+14/t+30), one sentence per locale (change it in exactly THREE
 * places, here).
 *
 * Wording is BYLAW-based + compliance-reviewed 2026-07-16 (pdpa-gdpr +
 * i18n reviews, CONFIRM-WITH-WORDING-FIX): a chamber's duty to terminate a
 * non-paying member comes from its own registered bylaws (ข้อบังคับ /
 * stadgar), NOT a statute — asserting a *law* compels it inside a dunning
 * message is a misrepresentation of legal compulsion (GDPR Art. 5(1)(a)
 * fairness; Thai Debt Collection Act; Swedish god inkassosed). The earlier
 * "statutory/ตามกฎหมาย/lagstadgad" phrasing was the overclaim; removed.
 * "more than 60 days after the due date" is code-accurate + fairer than the
 * old "within 60 days" (the cron terminates only once today > due_date + 60,
 * so the member keeps the full 60 days).
 *
 * Two known couplings, both deliberate for the single-tenant present: the
 * tenant name "SweCham" and the "60 days" figure (TERMINATION_DAYS_AFTER_DUE
 * in lapse-cycles-on-grace-expiry.ts) are literals — tokenise per-tenant
 * before onboarding tenant #2 (design § Post-review follow-ups). SweCham may
 * optionally cite a specific bylaw article later (precision, not a gate).
 */
export const STATUTORY_TERMINATION_WARNING: Record<RenewalEmailLocale, string> = {
  en: 'Under its bylaws, SweCham is required to terminate the membership of members whose fees remain unpaid more than 60 days after the invoice due date.',
  th: 'SweCham มีหน้าที่ตามข้อบังคับที่ต้องยุติสมาชิกภาพของสมาชิกที่ค้างชำระค่าสมาชิกเกิน 60 วันนับจากวันครบกำหนดชำระในใบแจ้งหนี้',
  sv: 'Enligt sina stadgar är SweCham skyldig att avsluta medlemskapet för medlemmar vars avgifter är obetalda mer än 60 dagar efter fakturans förfallodag.',
};

const EN: Partial<Record<CopyKey, ReminderEmailCopy>> = {
  // Thai Alumni — light cadence (4 emails)
  'thai_alumni.t-30': {
    subject: 'Your {tier} membership renews in {daysUntilExpiry} days',
    body: 'Dear {firstName}, your {companyName} {tier} membership renews on {expiresAt}. Click below to renew now and keep your benefits active.',
    cta: 'Renew now',
  },
  'thai_alumni.t-14': {
    subject: 'Reminder: {tier} membership renewal in {daysUntilExpiry} days',
    body: 'Hi {firstName}, just a reminder that {companyName}\'s {tier} membership expires on {expiresAt}. Renew today to avoid any lapse in benefits.',
    cta: 'Renew now',
  },
  'thai_alumni.t-3': {
    subject: 'Final reminder: {tier} membership expires in {daysUntilExpiry} days',
    body: 'Hi {firstName}, your {tier} membership for {companyName} expires on {expiresAt} — that\'s in just {daysUntilExpiry} days. Click to renew now.',
    cta: 'Renew now',
  },
  'thai_alumni.t+7': {
    subject: 'Your {tier} membership has lapsed',
    body: `Hi {firstName}, your {tier} membership for {companyName} expired on {expiresAt}. Reactivate now to restore your benefits and stay connected with the chamber. ${STATUTORY_TERMINATION_WARNING.en}`,
    cta: 'Reactivate now',
  },

  // Start-up — full cadence (6 emails)
  'start_up.t-60': {
    subject: 'Your {tier} membership renews in {daysUntilExpiry} days',
    body: 'Dear {firstName}, your {companyName} {tier} membership renews on {expiresAt}. Plan ahead and renew now to keep your chamber benefits active.',
    cta: 'Renew now',
  },
  'start_up.t-30': {
    subject: 'Renewal reminder: {tier} membership in {daysUntilExpiry} days',
    body: 'Hi {firstName}, your {companyName} {tier} membership expires on {expiresAt}. Renew today to ensure uninterrupted access to events and networking.',
    cta: 'Renew now',
  },
  'start_up.t-14': {
    subject: 'Two weeks left: {tier} membership renewal',
    body: 'Hi {firstName}, your {tier} membership for {companyName} expires on {expiresAt} — just two weeks away. Click below to renew.',
    cta: 'Renew now',
  },
  'start_up.t-7': {
    subject: 'One week left: {tier} membership renewal',
    body: 'Hi {firstName}, your {companyName} {tier} membership expires on {expiresAt}. Renew this week to avoid losing access to chamber benefits.',
    cta: 'Renew now',
  },
  'start_up.t+0': {
    subject: 'Your {tier} membership expires today',
    body: 'Hi {firstName}, today is the last day of {companyName}\'s {tier} membership. Renew now to keep your benefits active without interruption.',
    cta: 'Renew now',
  },
  'start_up.t+7': {
    subject: 'Your {tier} membership has lapsed',
    body: `Hi {firstName}, your {tier} membership for {companyName} expired on {expiresAt}. Reactivate now to restore benefits. ${STATUTORY_TERMINATION_WARNING.en}`,
    cta: 'Reactivate now',
  },

  // Regular — same cadence as Start-up (uses same copy with {tier} discriminator)
  'regular.t-60': {
    subject: 'Your {tier} membership renews in {daysUntilExpiry} days',
    body: 'Dear {firstName}, your {companyName} {tier} membership renews on {expiresAt}. Renew now to maintain your chamber access and benefits.',
    cta: 'Renew now',
  },
  'regular.t-30': {
    subject: 'Renewal reminder: {tier} membership in {daysUntilExpiry} days',
    body: 'Hi {firstName}, your {tier} membership for {companyName} expires on {expiresAt}. Renew today to keep your benefits active.',
    cta: 'Renew now',
  },
  'regular.t-14': {
    subject: 'Two weeks left: {tier} membership renewal',
    body: 'Hi {firstName}, just a reminder that {companyName}\'s {tier} membership expires on {expiresAt}. Click to renew now.',
    cta: 'Renew now',
  },
  'regular.t-7': {
    subject: 'One week left: {tier} membership renewal',
    body: 'Hi {firstName}, your {tier} membership for {companyName} expires on {expiresAt}. Please renew this week.',
    cta: 'Renew now',
  },
  'regular.t+0': {
    subject: 'Your {tier} membership expires today',
    body: 'Hi {firstName}, today is the last day of {companyName}\'s {tier} membership. Renew now to keep benefits active.',
    cta: 'Renew now',
  },
  'regular.t+7': {
    subject: 'Your {tier} membership has lapsed',
    body: `Hi {firstName}, your {tier} membership expired on {expiresAt}. Reactivate now to restore your chamber benefits. ${STATUTORY_TERMINATION_WARNING.en}`,
    cta: 'Reactivate now',
  },

  // Premium — extended cadence (7 emails — earliest T-90, post-grace T+14)
  'premium.t-90': {
    subject: 'Your {tier} membership renews in {daysUntilExpiry} days',
    body: 'Dear {firstName}, thank you for being a {tier} member. Your {companyName} membership renews on {expiresAt}. Renew now to plan your year ahead with the chamber.',
    cta: 'Renew now',
  },
  'premium.t-60': {
    subject: '{tier} renewal: {daysUntilExpiry} days remaining',
    body: 'Dear {firstName}, your {companyName} {tier} membership renews on {expiresAt}. Click below to renew at the current Premium tier rate.',
    cta: 'Renew now',
  },
  'premium.t-30': {
    subject: 'One month left: {tier} membership renewal',
    body: 'Hi {firstName}, your {companyName} {tier} membership expires on {expiresAt}. Renew now to lock in your benefit summary for the new year.',
    cta: 'Renew now',
  },
  'premium.t-14': {
    subject: 'Two weeks left: {tier} membership renewal',
    body: 'Hi {firstName}, your {tier} membership for {companyName} expires on {expiresAt}. Renew this week to avoid lapsing.',
    cta: 'Renew now',
  },
  'premium.t-7': {
    subject: 'One week left: {tier} membership renewal',
    body: 'Hi {firstName}, your {companyName} {tier} membership expires on {expiresAt}. Renew now.',
    cta: 'Renew now',
  },
  'premium.t+0': {
    subject: 'Your {tier} membership expires today',
    body: 'Hi {firstName}, today is the last day of {companyName}\'s {tier} membership. Renew now to retain Premium benefits.',
    cta: 'Renew now',
  },
  'premium.t+14': {
    subject: 'Your {tier} membership has lapsed',
    body: `Hi {firstName}, your {tier} membership for {companyName} expired on {expiresAt}. Reactivate now to restore Premium benefits. ${STATUTORY_TERMINATION_WARNING.en}`,
    cta: 'Reactivate now',
  },

  // Partnership — long cadence (mostly tasks; ~6 email steps)
  'partnership.t-120': {
    subject: 'Your {tier} renews in {daysUntilExpiry} days — let\'s plan ahead',
    body: 'Dear {firstName}, your {companyName} {tier} agreement renews on {expiresAt}. Our executive team will be in touch to plan the renewal.',
    cta: 'Review benefits',
  },
  'partnership.t-90': {
    subject: '{tier} renewal: {daysUntilExpiry} days to expire',
    body: 'Dear {firstName}, this is a reminder that your {companyName} {tier} renews on {expiresAt}. Please review your benefit fulfillment summary linked below.',
    cta: 'Review benefits',
  },
  'partnership.t-30': {
    subject: 'Final month: {tier} renewal in {daysUntilExpiry} days',
    body: 'Dear {firstName}, your {companyName} {tier} expires on {expiresAt}. Click to renew or schedule a renewal meeting with our executive director.',
    cta: 'Renew now',
  },
  'partnership.t-14': {
    subject: 'Two weeks: {tier} membership renewal',
    body: 'Dear {firstName}, your {tier} agreement for {companyName} expires on {expiresAt}. Please confirm renewal terms.',
    cta: 'Renew now',
  },
  'partnership.t+0': {
    subject: 'Your {tier} agreement expires today',
    body: 'Dear {firstName}, today is the last day of your {companyName} {tier} agreement. Please reach out to renew.',
    cta: 'Renew now',
  },
  'partnership.t+30': {
    subject: 'Your {tier} agreement has lapsed',
    body: `Dear {firstName}, your {tier} agreement for {companyName} expired on {expiresAt}. Reactivate now or contact us to discuss renewal. ${STATUTORY_TERMINATION_WARNING.en}`,
    cta: 'Reactivate now',
  },
};

// Thai locale — full coverage across all 5 tiers × all 29 schedule
// steps (J7b-H16). Tone:
//   - Long-cadence openers (T-90/T-120/T-60 advance notice): "เรียนคุณ"
//     formal opener for premium/partnership; "สวัสดีคุณ" friendlier
//     casual opener for thai_alumni/start_up/regular early notices.
//   - Mid-cadence (T-30/T-14): "สวัสดีคุณ" universal friendly tone.
//   - Final-window (T-7/T-3/T+0): tighter, action-oriented.
//   - Post-grace (T+0+/T+7/T+14/T+30): empathetic, restorative.
// FR-014 dual-format date: `{expiresAt}` is rendered dual-format
// (e.g., "15 ส.ค. 2569 (15 August 2026)") by the gateway before
// interpolation, so body strings just reference {expiresAt} verbatim.
const TH: Partial<Record<CopyKey, ReminderEmailCopy>> = {
  // -------------------------------------------------------------------------
  // Thai Alumni (4 emails) — light cadence
  // -------------------------------------------------------------------------
  'thai_alumni.t-30': {
    subject: 'การเป็นสมาชิก {tier} ของคุณจะหมดอายุในอีก {daysUntilExpiry} วัน',
    body: 'เรียนคุณ {firstName} การเป็นสมาชิก {tier} ของ {companyName} จะหมดอายุในวันที่ {expiresAt} กรุณาคลิกปุ่มด้านล่างเพื่อต่ออายุการเป็นสมาชิกและคงสิทธิประโยชน์ทั้งหมดไว้',
    cta: 'ต่ออายุสมาชิก',
  },
  'thai_alumni.t-14': {
    subject: 'แจ้งเตือน: สมาชิก {tier} จะหมดอายุในอีก {daysUntilExpiry} วัน',
    body: 'สวัสดีคุณ {firstName} ขอแจ้งเตือนว่าการเป็นสมาชิก {tier} ของ {companyName} จะหมดอายุในวันที่ {expiresAt} กรุณาต่ออายุวันนี้เพื่อไม่ให้สิทธิประโยชน์ของคุณขาดช่วง',
    cta: 'ต่ออายุสมาชิก',
  },
  'thai_alumni.t-3': {
    subject: 'แจ้งเตือนครั้งสุดท้าย: สมาชิก {tier} หมดอายุในอีก {daysUntilExpiry} วัน',
    body: 'สวัสดีคุณ {firstName} การเป็นสมาชิก {tier} ของ {companyName} จะหมดอายุในวันที่ {expiresAt} เหลือเวลาอีกเพียง {daysUntilExpiry} วัน คลิกเพื่อต่ออายุทันที',
    cta: 'ต่ออายุสมาชิก',
  },
  'thai_alumni.t+7': {
    subject: 'การเป็นสมาชิก {tier} ของคุณหมดอายุแล้ว',
    body: `สวัสดีคุณ {firstName} การเป็นสมาชิก {tier} ของ {companyName} ได้หมดอายุไปเมื่อวันที่ {expiresAt} กรุณาเปิดใช้งานอีกครั้งเพื่อกลับมารับสิทธิประโยชน์และเชื่อมต่อกับเครือข่ายของหอการค้า ${STATUTORY_TERMINATION_WARNING.th}`,
    cta: 'เปิดใช้งานอีกครั้ง',
  },

  // -------------------------------------------------------------------------
  // Start-up (6 emails) — full cadence
  // -------------------------------------------------------------------------
  'start_up.t-60': {
    subject: 'การเป็นสมาชิก {tier} ของคุณจะหมดอายุในอีก {daysUntilExpiry} วัน',
    body: 'เรียนคุณ {firstName} การเป็นสมาชิก {tier} ของ {companyName} จะหมดอายุในวันที่ {expiresAt} วางแผนล่วงหน้าและต่ออายุตั้งแต่วันนี้เพื่อรักษาสิทธิประโยชน์ของหอการค้าให้ต่อเนื่อง',
    cta: 'ต่ออายุสมาชิก',
  },
  'start_up.t-30': {
    subject: 'แจ้งเตือนการต่ออายุ: สมาชิก {tier} ในอีก {daysUntilExpiry} วัน',
    body: 'สวัสดีคุณ {firstName} การเป็นสมาชิก {tier} ของ {companyName} จะหมดอายุในวันที่ {expiresAt} กรุณาต่ออายุวันนี้เพื่อให้คุณยังเข้าร่วมกิจกรรมและเครือข่ายธุรกิจได้อย่างต่อเนื่อง',
    cta: 'ต่ออายุสมาชิก',
  },
  'start_up.t-14': {
    subject: 'เหลืออีก 2 สัปดาห์: การต่ออายุสมาชิก {tier}',
    body: 'สวัสดีคุณ {firstName} การเป็นสมาชิก {tier} ของ {companyName} จะหมดอายุในวันที่ {expiresAt} เหลือเวลาอีกเพียง 2 สัปดาห์ คลิกด้านล่างเพื่อต่ออายุ',
    cta: 'ต่ออายุสมาชิก',
  },
  'start_up.t-7': {
    subject: 'เหลืออีก 1 สัปดาห์: การต่ออายุสมาชิก {tier}',
    body: 'สวัสดีคุณ {firstName} การเป็นสมาชิก {tier} ของ {companyName} จะหมดอายุในวันที่ {expiresAt} โปรดต่ออายุภายในสัปดาห์นี้เพื่อไม่ให้สิทธิประโยชน์ของหอการค้าขาดช่วง',
    cta: 'ต่ออายุสมาชิก',
  },
  'start_up.t+0': {
    subject: 'การเป็นสมาชิก {tier} ของคุณจะหมดอายุวันนี้',
    body: 'สวัสดีคุณ {firstName} วันนี้คือวันสุดท้ายของการเป็นสมาชิก {tier} ของ {companyName} กรุณาต่ออายุทันทีเพื่อรักษาสิทธิประโยชน์ไว้โดยไม่ขาดช่วง',
    cta: 'ต่ออายุสมาชิก',
  },
  'start_up.t+7': {
    subject: 'การเป็นสมาชิก {tier} ของคุณหมดอายุแล้ว',
    body: `สวัสดีคุณ {firstName} การเป็นสมาชิก {tier} ของ {companyName} ได้หมดอายุไปเมื่อวันที่ {expiresAt} เปิดใช้งานอีกครั้งเพื่อกลับมารับสิทธิประโยชน์ทั้งหมด ${STATUTORY_TERMINATION_WARNING.th}`,
    cta: 'เปิดใช้งานอีกครั้ง',
  },

  // -------------------------------------------------------------------------
  // Regular (6 emails) — full cadence (mirrors start_up structure)
  // -------------------------------------------------------------------------
  'regular.t-60': {
    subject: 'การเป็นสมาชิก {tier} ของคุณจะหมดอายุในอีก {daysUntilExpiry} วัน',
    body: 'เรียนคุณ {firstName} การเป็นสมาชิก {tier} ของ {companyName} จะหมดอายุในวันที่ {expiresAt} ต่ออายุตั้งแต่วันนี้เพื่อรักษาสิทธิเข้าร่วมหอการค้าและสิทธิประโยชน์ทั้งหมด',
    cta: 'ต่ออายุสมาชิก',
  },
  'regular.t-30': {
    subject: 'แจ้งเตือนการต่ออายุ: สมาชิก {tier} ในอีก {daysUntilExpiry} วัน',
    body: 'สวัสดีคุณ {firstName} การเป็นสมาชิก {tier} ของ {companyName} จะหมดอายุในวันที่ {expiresAt} กรุณาต่ออายุวันนี้เพื่อให้สิทธิประโยชน์ของคุณยังคงใช้ได้',
    cta: 'ต่ออายุสมาชิก',
  },
  'regular.t-14': {
    subject: 'เหลืออีก 2 สัปดาห์: การต่ออายุสมาชิก {tier}',
    body: 'สวัสดีคุณ {firstName} ขอแจ้งเตือนว่าการเป็นสมาชิก {tier} ของ {companyName} จะหมดอายุในวันที่ {expiresAt} คลิกเพื่อต่ออายุทันที',
    cta: 'ต่ออายุสมาชิก',
  },
  'regular.t-7': {
    subject: 'เหลืออีก 1 สัปดาห์: การต่ออายุสมาชิก {tier}',
    body: 'สวัสดีคุณ {firstName} การเป็นสมาชิก {tier} ของ {companyName} จะหมดอายุในวันที่ {expiresAt} กรุณาต่ออายุภายในสัปดาห์นี้',
    cta: 'ต่ออายุสมาชิก',
  },
  'regular.t+0': {
    subject: 'การเป็นสมาชิก {tier} ของคุณจะหมดอายุวันนี้',
    body: 'สวัสดีคุณ {firstName} วันนี้คือวันสุดท้ายของการเป็นสมาชิก {tier} ของ {companyName} ต่ออายุทันทีเพื่อรักษาสิทธิประโยชน์',
    cta: 'ต่ออายุสมาชิก',
  },
  'regular.t+7': {
    subject: 'การเป็นสมาชิก {tier} ของคุณหมดอายุแล้ว',
    body: `สวัสดีคุณ {firstName} การเป็นสมาชิก {tier} ของ {companyName} หมดอายุไปเมื่อวันที่ {expiresAt} เปิดใช้งานอีกครั้งเพื่อกลับมารับสิทธิประโยชน์ของหอการค้า ${STATUTORY_TERMINATION_WARNING.th}`,
    cta: 'เปิดใช้งานอีกครั้ง',
  },

  // -------------------------------------------------------------------------
  // Premium (7 emails) — extended cadence (T-90 advance + T+14 grace)
  // -------------------------------------------------------------------------
  'premium.t-90': {
    subject: 'การเป็นสมาชิก {tier} ของคุณจะหมดอายุในอีก {daysUntilExpiry} วัน',
    body: 'เรียนคุณ {firstName} ขอบคุณที่ร่วมเป็นสมาชิก {tier} กับเรา การเป็นสมาชิกของ {companyName} จะหมดอายุในวันที่ {expiresAt} กรุณาต่ออายุเพื่อวางแผนกิจกรรมร่วมกับหอการค้าตลอดทั้งปี',
    cta: 'ต่ออายุสมาชิก',
  },
  'premium.t-60': {
    subject: 'การต่ออายุ {tier}: เหลือเวลา {daysUntilExpiry} วัน',
    body: 'เรียนคุณ {firstName} การเป็นสมาชิก {tier} ของ {companyName} จะหมดอายุในวันที่ {expiresAt} คลิกด้านล่างเพื่อต่ออายุในอัตรา Premium ปัจจุบัน',
    cta: 'ต่ออายุสมาชิก',
  },
  'premium.t-30': {
    subject: 'หนึ่งเดือนสุดท้าย: การต่ออายุสมาชิก {tier}',
    body: 'สวัสดีคุณ {firstName} การเป็นสมาชิก {tier} ของ {companyName} จะหมดอายุในวันที่ {expiresAt} กรุณาต่ออายุเพื่อรักษาสิทธิประโยชน์ระดับ Premium สำหรับปีถัดไป',
    cta: 'ต่ออายุสมาชิก',
  },
  'premium.t-14': {
    subject: 'เหลืออีก 2 สัปดาห์: การต่ออายุสมาชิก {tier}',
    body: 'สวัสดีคุณ {firstName} การเป็นสมาชิก {tier} ของ {companyName} จะหมดอายุในวันที่ {expiresAt} กรุณาต่ออายุภายในสัปดาห์นี้เพื่อไม่ให้ขาดช่วง',
    cta: 'ต่ออายุสมาชิก',
  },
  'premium.t-7': {
    subject: 'เหลืออีก 1 สัปดาห์: การต่ออายุสมาชิก {tier}',
    body: 'สวัสดีคุณ {firstName} การเป็นสมาชิก {tier} ของ {companyName} จะหมดอายุในวันที่ {expiresAt} กรุณาต่ออายุทันที',
    cta: 'ต่ออายุสมาชิก',
  },
  'premium.t+0': {
    subject: 'การเป็นสมาชิก {tier} ของคุณจะหมดอายุวันนี้',
    body: 'สวัสดีคุณ {firstName} วันนี้คือวันสุดท้ายของการเป็นสมาชิก {tier} ของ {companyName} ต่ออายุทันทีเพื่อรักษาสิทธิประโยชน์ระดับ Premium ไว้',
    cta: 'ต่ออายุสมาชิก',
  },
  'premium.t+14': {
    subject: 'การเป็นสมาชิก {tier} ของคุณหมดอายุแล้ว',
    body: `สวัสดีคุณ {firstName} การเป็นสมาชิก {tier} ของ {companyName} หมดอายุไปเมื่อวันที่ {expiresAt} เปิดใช้งานอีกครั้งเพื่อกลับมารับสิทธิประโยชน์ระดับ Premium ${STATUTORY_TERMINATION_WARNING.th}`,
    cta: 'เปิดใช้งานอีกครั้ง',
  },

  // -------------------------------------------------------------------------
  // Partnership (6 emails) — long cadence; ED-led + agreement-tone
  // -------------------------------------------------------------------------
  'partnership.t-120': {
    subject: 'ข้อตกลง {tier} ของคุณจะหมดอายุในอีก {daysUntilExpiry} วัน — มาวางแผนล่วงหน้ากัน',
    body: 'เรียนคุณ {firstName} ข้อตกลง {tier} ของ {companyName} จะหมดอายุในวันที่ {expiresAt} ทีมผู้บริหารของเราจะติดต่อเพื่อวางแผนการต่ออายุร่วมกัน',
    cta: 'ตรวจสอบสิทธิประโยชน์',
  },
  'partnership.t-90': {
    subject: 'การต่ออายุ {tier}: เหลือเวลา {daysUntilExpiry} วันก่อนหมดอายุ',
    body: 'เรียนคุณ {firstName} ขอแจ้งเตือนว่าข้อตกลง {tier} ของ {companyName} จะหมดอายุในวันที่ {expiresAt} กรุณาตรวจสอบสรุปการใช้สิทธิประโยชน์ตามลิงก์ด้านล่าง',
    cta: 'ตรวจสอบสิทธิประโยชน์',
  },
  'partnership.t-30': {
    subject: 'เดือนสุดท้าย: การต่ออายุ {tier} ในอีก {daysUntilExpiry} วัน',
    body: 'เรียนคุณ {firstName} ข้อตกลง {tier} ของ {companyName} จะหมดอายุในวันที่ {expiresAt} กรุณาคลิกเพื่อต่ออายุหรือนัดประชุมกับ Executive Director',
    cta: 'ต่ออายุสมาชิก',
  },
  'partnership.t-14': {
    subject: 'เหลืออีก 2 สัปดาห์: การต่ออายุข้อตกลง {tier}',
    body: 'เรียนคุณ {firstName} ข้อตกลง {tier} ของ {companyName} จะหมดอายุในวันที่ {expiresAt} กรุณายืนยันเงื่อนไขการต่ออายุ',
    cta: 'ต่ออายุสมาชิก',
  },
  'partnership.t+0': {
    subject: 'ข้อตกลง {tier} ของคุณจะหมดอายุวันนี้',
    body: 'เรียนคุณ {firstName} วันนี้คือวันสุดท้ายของข้อตกลง {tier} ของ {companyName} กรุณาติดต่อเราเพื่อต่ออายุข้อตกลง',
    cta: 'ต่ออายุสมาชิก',
  },
  'partnership.t+30': {
    subject: 'ข้อตกลง {tier} ของคุณหมดอายุแล้ว',
    body: `เรียนคุณ {firstName} ข้อตกลง {tier} ของ {companyName} ได้หมดอายุไปเมื่อวันที่ {expiresAt} เปิดใช้งานอีกครั้งหรือติดต่อเราเพื่อหารือเรื่องการต่ออายุ ${STATUTORY_TERMINATION_WARNING.th}`,
    cta: 'เปิดใช้งานอีกครั้ง',
  },
};

// Swedish locale — full coverage across all 5 tiers × all 29 schedule
// steps (J7b-H16). Tone:
//   - "Hej {firstName}" — friendly opener for thai_alumni / start_up /
//     regular cadence (matches Swedish chamber norms).
//   - "Bästa {firstName}" — formal opener for premium / partnership
//     long-cadence advance notices (T-90/T-120/T-60 premium first
//     touch). Reverts to "Hej" mid-cadence (T-30 onward).
//   - Verb forms: "förnyas" (passive — renews), "löper ut" (expires),
//     "återaktivera" (reactivate). Avoid English borrowings ("renew") —
//     the SV speakers in chamber comms expect native Swedish vocabulary.
const SV: Partial<Record<CopyKey, ReminderEmailCopy>> = {
  // -------------------------------------------------------------------------
  // Thai Alumni (4 emails)
  // -------------------------------------------------------------------------
  'thai_alumni.t-30': {
    subject: 'Ditt {tier}-medlemskap förnyas om {daysUntilExpiry} dagar',
    body: 'Hej {firstName}, ditt {companyName} {tier}-medlemskap förnyas den {expiresAt}. Klicka nedan för att förnya nu och behålla dina förmåner.',
    cta: 'Förnya nu',
  },
  'thai_alumni.t-14': {
    subject: 'Påminnelse: {tier}-medlemskap förnyas om {daysUntilExpiry} dagar',
    body: 'Hej {firstName}, en påminnelse om att {companyName}s {tier}-medlemskap löper ut den {expiresAt}. Förnya idag för att undvika avbrott i förmånerna.',
    cta: 'Förnya nu',
  },
  'thai_alumni.t-3': {
    subject: 'Sista påminnelsen: {tier}-medlemskap löper ut om {daysUntilExpiry} dagar',
    body: 'Hej {firstName}, ditt {tier}-medlemskap för {companyName} löper ut den {expiresAt} — det är bara om {daysUntilExpiry} dagar. Klicka för att förnya nu.',
    cta: 'Förnya nu',
  },
  'thai_alumni.t+7': {
    subject: 'Ditt {tier}-medlemskap har löpt ut',
    body: `Hej {firstName}, ditt {tier}-medlemskap för {companyName} löpte ut den {expiresAt}. Återaktivera nu för att återfå dina förmåner och hålla kontakten med kammaren. ${STATUTORY_TERMINATION_WARNING.sv}`,
    cta: 'Återaktivera nu',
  },

  // -------------------------------------------------------------------------
  // Start-up (6 emails)
  // -------------------------------------------------------------------------
  'start_up.t-60': {
    subject: 'Ditt {tier}-medlemskap förnyas om {daysUntilExpiry} dagar',
    body: 'Hej {firstName}, ditt {companyName} {tier}-medlemskap förnyas den {expiresAt}. Planera i förväg och förnya nu för att hålla kammarens förmåner aktiva.',
    cta: 'Förnya nu',
  },
  'start_up.t-30': {
    subject: 'Förnyelsepåminnelse: {tier}-medlemskap om {daysUntilExpiry} dagar',
    body: 'Hej {firstName}, ditt {companyName} {tier}-medlemskap löper ut den {expiresAt}. Förnya idag för att säkerställa oavbruten tillgång till evenemang och nätverk.',
    cta: 'Förnya nu',
  },
  'start_up.t-14': {
    subject: 'Två veckor kvar: {tier}-medlemskap förnyas',
    body: 'Hej {firstName}, ditt {tier}-medlemskap för {companyName} löper ut den {expiresAt} — bara två veckor bort. Klicka nedan för att förnya.',
    cta: 'Förnya nu',
  },
  'start_up.t-7': {
    subject: 'En vecka kvar: {tier}-medlemskap förnyas',
    body: 'Hej {firstName}, ditt {companyName} {tier}-medlemskap löper ut den {expiresAt}. Förnya denna vecka för att inte förlora kammarens förmåner.',
    cta: 'Förnya nu',
  },
  'start_up.t+0': {
    subject: 'Ditt {tier}-medlemskap löper ut idag',
    body: 'Hej {firstName}, idag är sista dagen för {companyName}s {tier}-medlemskap. Förnya nu för att behålla förmånerna utan avbrott.',
    cta: 'Förnya nu',
  },
  'start_up.t+7': {
    subject: 'Ditt {tier}-medlemskap har löpt ut',
    body: `Hej {firstName}, ditt {tier}-medlemskap för {companyName} löpte ut den {expiresAt}. Återaktivera nu för att återfå förmånerna. ${STATUTORY_TERMINATION_WARNING.sv}`,
    cta: 'Återaktivera nu',
  },

  // -------------------------------------------------------------------------
  // Regular (6 emails)
  // -------------------------------------------------------------------------
  'regular.t-60': {
    subject: 'Ditt {tier}-medlemskap förnyas om {daysUntilExpiry} dagar',
    body: 'Hej {firstName}, ditt {companyName} {tier}-medlemskap förnyas den {expiresAt}. Förnya nu för att behålla din kammartillhörighet och förmåner.',
    cta: 'Förnya nu',
  },
  'regular.t-30': {
    subject: 'Förnyelsepåminnelse: {tier}-medlemskap om {daysUntilExpiry} dagar',
    body: 'Hej {firstName}, ditt {tier}-medlemskap för {companyName} löper ut den {expiresAt}. Förnya idag för att behålla dina förmåner.',
    cta: 'Förnya nu',
  },
  'regular.t-14': {
    subject: 'Två veckor kvar: {tier}-medlemskap förnyas',
    body: 'Hej {firstName}, en påminnelse om att {companyName}s {tier}-medlemskap löper ut den {expiresAt}. Klicka för att förnya nu.',
    cta: 'Förnya nu',
  },
  'regular.t-7': {
    subject: 'En vecka kvar: {tier}-medlemskap förnyas',
    body: 'Hej {firstName}, ditt {tier}-medlemskap för {companyName} löper ut den {expiresAt}. Vänligen förnya denna vecka.',
    cta: 'Förnya nu',
  },
  'regular.t+0': {
    subject: 'Ditt {tier}-medlemskap löper ut idag',
    body: 'Hej {firstName}, idag är sista dagen för {companyName}s {tier}-medlemskap. Förnya nu för att hålla förmånerna aktiva.',
    cta: 'Förnya nu',
  },
  'regular.t+7': {
    subject: 'Ditt {tier}-medlemskap har löpt ut',
    body: `Hej {firstName}, ditt {tier}-medlemskap löpte ut den {expiresAt}. Återaktivera nu för att återfå dina kammarförmåner. ${STATUTORY_TERMINATION_WARNING.sv}`,
    cta: 'Återaktivera nu',
  },

  // -------------------------------------------------------------------------
  // Premium (7 emails) — extended cadence (T-90 advance + T+14 grace)
  // -------------------------------------------------------------------------
  'premium.t-90': {
    subject: 'Ditt {tier}-medlemskap förnyas om {daysUntilExpiry} dagar',
    body: 'Bästa {firstName}, tack för att du är en {tier}-medlem. Ditt {companyName}-medlemskap förnyas den {expiresAt}. Förnya nu för att planera ditt år tillsammans med kammaren.',
    cta: 'Förnya nu',
  },
  'premium.t-60': {
    subject: '{tier}-förnyelse: {daysUntilExpiry} dagar kvar',
    body: 'Bästa {firstName}, ditt {companyName} {tier}-medlemskap förnyas den {expiresAt}. Klicka nedan för att förnya till nuvarande Premium-pris.',
    cta: 'Förnya nu',
  },
  'premium.t-30': {
    subject: 'En månad kvar: {tier}-medlemskap förnyas',
    body: 'Hej {firstName}, ditt {companyName} {tier}-medlemskap löper ut den {expiresAt}. Förnya nu för att låsa in din förmånssammanställning för det nya året.',
    cta: 'Förnya nu',
  },
  'premium.t-14': {
    subject: 'Två veckor kvar: {tier}-medlemskap förnyas',
    body: 'Hej {firstName}, ditt {tier}-medlemskap för {companyName} löper ut den {expiresAt}. Förnya denna vecka för att undvika avbrott.',
    cta: 'Förnya nu',
  },
  'premium.t-7': {
    subject: 'En vecka kvar: {tier}-medlemskap förnyas',
    body: 'Hej {firstName}, ditt {companyName} {tier}-medlemskap löper ut den {expiresAt}. Förnya nu.',
    cta: 'Förnya nu',
  },
  'premium.t+0': {
    subject: 'Ditt {tier}-medlemskap löper ut idag',
    body: 'Hej {firstName}, idag är sista dagen för {companyName}s {tier}-medlemskap. Förnya nu för att behålla Premium-förmånerna.',
    cta: 'Förnya nu',
  },
  'premium.t+14': {
    subject: 'Ditt {tier}-medlemskap har löpt ut',
    body: `Hej {firstName}, ditt {tier}-medlemskap för {companyName} löpte ut den {expiresAt}. Återaktivera nu för att återfå Premium-förmånerna. ${STATUTORY_TERMINATION_WARNING.sv}`,
    cta: 'Återaktivera nu',
  },

  // -------------------------------------------------------------------------
  // Partnership (6 emails) — long cadence; ED-led + agreement-tone
  // -------------------------------------------------------------------------
  'partnership.t-120': {
    subject: 'Ditt {tier} förnyas om {daysUntilExpiry} dagar — låt oss planera framåt',
    body: 'Bästa {firstName}, ditt {companyName} {tier}-avtal förnyas den {expiresAt}. Vårt ledningsteam kommer att höra av sig för att planera förnyelsen.',
    cta: 'Granska förmåner',
  },
  'partnership.t-90': {
    subject: '{tier}-förnyelse: {daysUntilExpiry} dagar till utgång',
    body: 'Bästa {firstName}, en påminnelse om att ditt {companyName} {tier} förnyas den {expiresAt}. Granska sammanfattningen av förmånsleverans i länken nedan.',
    cta: 'Granska förmåner',
  },
  'partnership.t-30': {
    subject: 'Sista månaden: {tier}-förnyelse om {daysUntilExpiry} dagar',
    body: 'Bästa {firstName}, ditt {companyName} {tier} löper ut den {expiresAt}. Klicka för att förnya eller boka ett förnyelsemöte med vår Executive Director.',
    cta: 'Förnya nu',
  },
  'partnership.t-14': {
    subject: 'Två veckor: {tier}-medlemskap förnyas',
    body: 'Bästa {firstName}, ditt {tier}-avtal för {companyName} löper ut den {expiresAt}. Vänligen bekräfta förnyelsevillkoren.',
    cta: 'Förnya nu',
  },
  'partnership.t+0': {
    subject: 'Ditt {tier}-avtal löper ut idag',
    body: 'Bästa {firstName}, idag är sista dagen för ditt {companyName} {tier}-avtal. Vänligen kontakta oss för att förnya.',
    cta: 'Förnya nu',
  },
  'partnership.t+30': {
    subject: 'Ditt {tier}-avtal har löpt ut',
    body: `Bästa {firstName}, ditt {tier}-avtal för {companyName} löpte ut den {expiresAt}. Återaktivera nu eller kontakta oss för att diskutera förnyelse. ${STATUTORY_TERMINATION_WARNING.sv}`,
    cta: 'Återaktivera nu',
  },
};

export const RENEWAL_COPY: Record<
  RenewalEmailLocale,
  Partial<Record<CopyKey, ReminderEmailCopy>>
> = { en: EN, th: TH, sv: SV };

/**
 * Resolve copy for a (tier, offset, locale) combination.
 *
 * EN-fallback per FR-013: when the locale-specific copy is missing,
 * falls back to EN with a non-fatal dev warning. The gateway emits
 * a structured WARN log on fallback so dev/CI can surface coverage
 * gaps. Throws ONLY when EN itself is missing — that's a code-level
 * regression (schedule policy added a step without copy).
 */
export function resolveCopy(
  tier: RenewalReminderTier,
  offset: RenewalReminderOffset,
  locale: RenewalEmailLocale,
): { copy: ReminderEmailCopy; usedFallback: boolean } {
  const key: CopyKey = `${tier}.${offset}`;
  const localeCopy = RENEWAL_COPY[locale]?.[key];
  if (localeCopy) {
    return { copy: localeCopy, usedFallback: false };
  }
  const enCopy = RENEWAL_COPY.en[key];
  if (!enCopy) {
    throw new Error(
      `F8 reminder copy missing for ${key} — schedule policy has an unmapped email step. Add to copy.ts before the F8 cron runs.`,
    );
  }
  return { copy: enCopy, usedFallback: locale !== 'en' };
}

/**
 * Interpolate `{name}` placeholders in a copy string with the given
 * substitution map. Unknown placeholders are LEFT IN PLACE (no-op)
 * to make missing variables visible in the output rather than
 * silently empty. The gateway logs a WARN if the rendered string
 * still contains `{*}` after interpolation.
 */
export function interpolateCopy(
  template: string,
  variables: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = variables[name];
    return value !== undefined ? String(value) : match;
  });
}

// ---------------------------------------------------------------------------
// 066 Round-2 §3.2(2): tier-less DUE-ANCHORED overdue-invoice track
// ---------------------------------------------------------------------------
// NOT part of the tier×offset RENEWAL_COPY matrix: these are statutory-style
// dunning notices anchored on the BILL due date, not the cycle expiry, so the
// "expired on {expiresAt}" framing of the post-expiry bodies is wrong here
// (a born-awaiting member's expiry is ~12 months in the future).
// Parity gate: tests/unit/renewals/due-track-copy.test.ts (NOT check:i18n).
// Placeholders: {firstName} + {companyName} ONLY (pinned by the same test).

export const DUE_TRACK_COPY: Record<
  RenewalEmailLocale,
  Record<import('@/modules/renewals/domain/due-track').DueTrackStepId, ReminderEmailCopy>
> = {
  en: {
    'due+7.email': {
      subject: 'Reminder: your SweCham membership invoice is past due',
      body: 'Hi {firstName}, our records show the membership invoice for {companyName} was due 7 days ago and remains unpaid. If you have already arranged payment, thank you — it may still be on its way to us. Otherwise, please settle the invoice at your earliest convenience to activate your membership benefits.',
      cta: 'View and pay the invoice',
    },
    'due+30.email': {
      subject: 'Important: unpaid membership invoice for {companyName}',
      body: `Hi {firstName}, the membership invoice for {companyName} is now 30 days past due and remains unpaid. ${STATUTORY_TERMINATION_WARNING.en} Please settle the invoice, or contact the chamber if you need assistance.`,
      cta: 'Pay the invoice now',
    },
  },
  th: {
    'due+7.email': {
      subject: 'แจ้งเตือน: ใบแจ้งหนี้ค่าสมาชิก SweCham เลยกำหนดชำระแล้ว',
      body: 'เรียนคุณ {firstName} ใบแจ้งหนี้ค่าสมาชิกของ {companyName} เลยกำหนดชำระมาแล้ว 7 วันและยังไม่ได้รับการชำระ หากท่านดำเนินการชำระแล้ว ขอขอบคุณ — ยอดอาจอยู่ระหว่างทาง มิฉะนั้นกรุณาชำระโดยเร็วเพื่อเปิดใช้สิทธิประโยชน์สมาชิกของท่าน',
      cta: 'ดูและชำระใบแจ้งหนี้',
    },
    'due+30.email': {
      subject: 'สำคัญ: ใบแจ้งหนี้ค่าสมาชิกของ {companyName} ค้างชำระ',
      body: `เรียนคุณ {firstName} ใบแจ้งหนี้ค่าสมาชิกของ {companyName} ค้างชำระเกินกำหนด 30 วันแล้ว ${STATUTORY_TERMINATION_WARNING.th} กรุณาชำระใบแจ้งหนี้ หรือติดต่อหอการค้าหากต้องการความช่วยเหลือ`,
      cta: 'ชำระใบแจ้งหนี้ตอนนี้',
    },
  },
  sv: {
    'due+7.email': {
      subject: 'Påminnelse: din SweCham-medlemsfaktura har förfallit',
      body: 'Hej {firstName}, medlemsfakturan för {companyName} förföll för 7 dagar sedan och är fortfarande obetald. Om du redan har ordnat betalningen — tack, den kan vara på väg. Annars ber vi dig betala fakturan snarast för att aktivera ditt medlemskaps förmåner.',
      cta: 'Visa och betala fakturan',
    },
    'due+30.email': {
      subject: 'Viktigt: obetald medlemsfaktura för {companyName}',
      body: `Hej {firstName}, medlemsfakturan för {companyName} är nu 30 dagar försenad och fortfarande obetald. ${STATUTORY_TERMINATION_WARNING.sv} Vänligen betala fakturan, eller kontakta kammaren om du behöver hjälp.`,
      cta: 'Betala fakturan nu',
    },
  },
};

/**
 * Locale-resolved due-track copy. All locales are fully populated (parity
 * pinned by due-track-copy.test.ts) — no EN-fallback path needed.
 */
export function resolveDueTrackCopy(
  stepId: import('@/modules/renewals/domain/due-track').DueTrackStepId,
  locale: RenewalEmailLocale,
): ReminderEmailCopy {
  return DUE_TRACK_COPY[locale][stepId];
}
