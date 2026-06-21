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
