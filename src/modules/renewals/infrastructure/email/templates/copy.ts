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
    body: 'Hi {firstName}, your {tier} membership for {companyName} expired on {expiresAt}. Reactivate now to restore your benefits and stay connected with the chamber.',
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
    body: 'Hi {firstName}, your {tier} membership for {companyName} expired on {expiresAt}. Reactivate now to restore benefits.',
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
    body: 'Hi {firstName}, your {tier} membership expired on {expiresAt}. Reactivate now to restore your chamber benefits.',
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
    body: 'Hi {firstName}, your {tier} membership for {companyName} expired on {expiresAt}. Reactivate now to restore Premium benefits.',
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
    body: 'Dear {firstName}, your {tier} agreement for {companyName} expired on {expiresAt}. Reactivate now or contact us to discuss renewal.',
    cta: 'Reactivate now',
  },
};

// Thai locale — Thai Alumni gets full Thai copy; other tiers use Thai
// translations. For Thai Alumni T-30 example (FR-014 inline dual-format
// requirement): `"การเป็นสมาชิกของคุณจะหมดอายุในวันที่ {expiresAt}"`
// where {expiresAt} is rendered dual-format by the gateway.
const TH: Partial<Record<CopyKey, ReminderEmailCopy>> = {
  'thai_alumni.t-30': {
    subject: 'การเป็นสมาชิก {tier} ของคุณจะหมดอายุในอีก {daysUntilExpiry} วัน',
    body: 'เรียนคุณ {firstName} การเป็นสมาชิก {tier} ของ {companyName} จะหมดอายุในวันที่ {expiresAt} กรุณาคลิกปุ่มด้านล่างเพื่อต่ออายุการเป็นสมาชิกและคงสิทธิประโยชน์ทั้งหมดไว้',
    cta: 'ต่ออายุสมาชิก',
  },
  'thai_alumni.t-14': {
    subject: 'แจ้งเตือน: สมาชิก {tier} จะหมดอายุในอีก {daysUntilExpiry} วัน',
    body: 'สวัสดีคุณ {firstName} ขอแจ้งเตือนว่าการเป็นสมาชิก {tier} ของ {companyName} จะหมดอายุในวันที่ {expiresAt} กรุณาต่ออายุวันนี้',
    cta: 'ต่ออายุสมาชิก',
  },
  'thai_alumni.t-3': {
    subject: 'แจ้งเตือนครั้งสุดท้าย: สมาชิก {tier} หมดอายุในอีก {daysUntilExpiry} วัน',
    body: 'สวัสดีคุณ {firstName} การเป็นสมาชิก {tier} ของ {companyName} จะหมดอายุในวันที่ {expiresAt} เหลือเวลาอีกเพียง {daysUntilExpiry} วัน คลิกเพื่อต่ออายุทันที',
    cta: 'ต่ออายุสมาชิก',
  },
  'thai_alumni.t+7': {
    subject: 'การเป็นสมาชิก {tier} ของคุณหมดอายุแล้ว',
    body: 'สวัสดีคุณ {firstName} การเป็นสมาชิก {tier} ของ {companyName} ได้หมดอายุไปเมื่อวันที่ {expiresAt} กรุณาเปิดใช้งานอีกครั้งเพื่อกลับมารับสิทธิประโยชน์',
    cta: 'เปิดใช้งานอีกครั้ง',
  },
  // start_up + regular share Thai copy structure (skip distinguishing in MVP).
  'start_up.t-30': {
    subject: 'แจ้งเตือนการต่ออายุ: สมาชิก {tier} ในอีก {daysUntilExpiry} วัน',
    body: 'สวัสดีคุณ {firstName} การเป็นสมาชิก {tier} ของ {companyName} จะหมดอายุในวันที่ {expiresAt} กรุณาต่ออายุวันนี้',
    cta: 'ต่ออายุสมาชิก',
  },
  'regular.t-30': {
    subject: 'แจ้งเตือนการต่ออายุ: สมาชิก {tier} ในอีก {daysUntilExpiry} วัน',
    body: 'สวัสดีคุณ {firstName} การเป็นสมาชิก {tier} ของ {companyName} จะหมดอายุในวันที่ {expiresAt} กรุณาต่ออายุวันนี้',
    cta: 'ต่ออายุสมาชิก',
  },
  'premium.t-30': {
    subject: 'หนึ่งเดือนสุดท้าย: การต่ออายุสมาชิก {tier}',
    body: 'สวัสดีคุณ {firstName} การเป็นสมาชิก {tier} ของ {companyName} จะหมดอายุในวันที่ {expiresAt} กรุณาต่ออายุเพื่อรักษาสิทธิประโยชน์ระดับ Premium',
    cta: 'ต่ออายุสมาชิก',
  },
  'partnership.t-30': {
    subject: 'เดือนสุดท้าย: การต่ออายุ {tier} ในอีก {daysUntilExpiry} วัน',
    body: 'เรียนคุณ {firstName} ข้อตกลง {tier} ของ {companyName} จะหมดอายุในวันที่ {expiresAt} กรุณาคลิกเพื่อต่ออายุหรือนัดประชุมกับ Executive Director',
    cta: 'ต่ออายุสมาชิก',
  },
};

// Swedish locale — same structure as EN for early ship.
const SV: Partial<Record<CopyKey, ReminderEmailCopy>> = {
  'thai_alumni.t-30': {
    subject: 'Ditt {tier}-medlemskap förnyas om {daysUntilExpiry} dagar',
    body: 'Hej {firstName}, ditt {companyName} {tier}-medlemskap förnyas den {expiresAt}. Klicka nedan för att förnya nu och behålla dina förmåner.',
    cta: 'Förnya nu',
  },
  'thai_alumni.t-14': {
    subject: 'Påminnelse: {tier}-medlemskap förnyas om {daysUntilExpiry} dagar',
    body: 'Hej {firstName}, en påminnelse om att {companyName}s {tier}-medlemskap löper ut den {expiresAt}. Förnya idag för att undvika avbrott.',
    cta: 'Förnya nu',
  },
  'start_up.t-30': {
    subject: 'Förnyelsepåminnelse: {tier}-medlemskap om {daysUntilExpiry} dagar',
    body: 'Hej {firstName}, ditt {companyName} {tier}-medlemskap löper ut den {expiresAt}. Förnya idag för att säkerställa fortsatt tillgång.',
    cta: 'Förnya nu',
  },
  'regular.t-30': {
    subject: 'Förnyelsepåminnelse: {tier}-medlemskap om {daysUntilExpiry} dagar',
    body: 'Hej {firstName}, ditt {tier}-medlemskap för {companyName} löper ut den {expiresAt}. Förnya idag för att behålla dina förmåner.',
    cta: 'Förnya nu',
  },
  'premium.t-30': {
    subject: 'En månad kvar: {tier}-medlemskap förnyas',
    body: 'Hej {firstName}, ditt {companyName} {tier}-medlemskap löper ut den {expiresAt}. Förnya nu för att behålla Premium-förmånerna.',
    cta: 'Förnya nu',
  },
  'partnership.t-30': {
    subject: 'Sista månaden: {tier}-förnyelse om {daysUntilExpiry} dagar',
    body: 'Bästa {firstName}, ditt {companyName} {tier}-avtal löper ut den {expiresAt}. Klicka för att förnya eller boka ett förnyelsemöte.',
    cta: 'Förnya nu',
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
