// src/modules/broadcasts/infrastructure/resend/bare-email.ts
//
// Verify-fix (2026-06-21) — BROADCASTS_FROM_EMAIL may be `Name <local@domain>`
// OR a bare `local@domain` (env.ts:332 accepts both). The gateway composes the
// per-broadcast `from` as `${fromName} <${addr}>`; if `addr` already carries a
// display name the brackets nest (`Name <SweCham <noreply@…>>`) and Resend
// rejects it. Mirror env.ts's parser to return the bare address.
export function extractBareEmail(value: string): string {
  return value.match(/<([^>]+)>\s*$/)?.[1]?.trim() ?? value.trim();
}

// Finding B (2026-06-21) — the gateway composes the per-broadcast `from`
// header as `${fromName} <${bareEmail}>`. `fromName` is
// `composeBroadcastFromName` = `${memberDisplayName} via ${tenantDisplayName}`,
// where `memberDisplayName` is the member's free-text company name. An
// unescaped `<` or `>` in that name (e.g. `<Acme> via SweCham`) nests inside
// the angle-bracketed address (`<Acme> via SweCham <noreply@…>`), producing
// an invalid RFC 5322 `from` that Resend rejects → permanent
// `failed_to_dispatch`. Strip the brackets (RFC 5322 display-name quoting is
// overkill for a member company name) and collapse the surrounding
// whitespace so the rendered name stays tidy.
export function stripAngleBrackets(name: string): string {
  return name.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
}
