---
paths:
  - "src/modules/broadcasts/**"
  - "src/app/*/admin/broadcasts/**"
  - "src/app/*/admin/marketing/**"
  - "src/app/*/portal/broadcasts/**"
  - "src/app/api/webhooks/resend-broadcasts/**"
  - "src/components/broadcast/**"
  - "src/app/api/broadcasts/**"
  - "src/app/*/admin/settings/broadcasts/**"
  - "tests/**/broadcasts/**"
  - "tests/**/broadcast/**"
---

# Broadcasts / E-Blast (F7 `010-email-broadcast` + `014-email-broadcast-advance`, F119)

- **Stack added**: 4 aggregates (Broadcast / BroadcastDelivery / MarketingUnsubscribe / RecipientSegment) · Tiptap@3.22.5 + isomorphic-dompurify@2.36.0 (both exact-pin) + email-validator@^2 + @tanstack/react-virtual@^3.
- **The Resend Broadcasts surface is separate from F1/F4 transactional** — its own API key, suppression list, webhook endpoint and reputation pool; the webhook is pinned to the Node runtime for Svix HMAC raw-body verification. Env `RESEND_BROADCASTS_API_KEY` + `RESEND_BROADCASTS_WEBHOOK_SECRET` + `UNSUBSCRIBE_TOKEN_SECRET` (≥32 bytes, distinct from `AUTH_COOKIE_SIGNING_SECRET`) + `BROADCASTS_FROM_EMAIL` + `FEATURE_F7_BROADCASTS`. Resend's `Idempotency-Key` is inert on `POST /broadcasts`.
- **Content rules**: sanitiser allowlist (FR-002a) is `p`/`br`/`strong`/`em`/`u`/`a[href]`/`ul`/`ol`/`li`/`h1-h4`/`blockquote`/`hr`, schemes `http`/`https`/`mailto`, **no `<img>`** (F119 images go through the separate image allowlist); subject ≤200, body ≤200 KB; applied in Application and the raw body is never persisted.
- **State rules**: quota reserves at `submitted` and consumes at `sending→sent`, with `currentQuotaYear` in the tenant's TZ. Immutable after submit (DB trigger `broadcasts_immutable_after_submit_fn`; several migrations redefine it, so read the newest `CREATE OR REPLACE` in `drizzle/migrations/` — the state-machine ELSE is fail-closed). F119's approval round (`FEATURE_EBLAST_MEMBER_APPROVAL`) is documented in `docs/runbooks/eblast-approval.md`.
- **Audience ceiling**: 500 recipients per tick (`DELIVERABLE_RECIPIENTS_PER_TICK`) unless `FEATURE_F7_IMPORT_AUDIENCE` is ON; the Resend account is on the Free plan (1,000 contacts, 3 segments), so at most two broadcasts can be in flight.
- **Resend provider facts, MEASURED 2026-10-29** (live Broadcasts account, sink address only; see spec 138):
  - DELETE on a `queued` or `sent` broadcast → 403 ("Only draft or scheduled broadcasts can be deleted"); the send still completes. `sending` is inferred from the message, not caught.
  - **DELETE of an audience while its broadcast is `queued` makes the broadcast `failed`, and no mail goes out.** Never delete an audience another tick could be sending into; the row CAS fence (D-037) exists for this.
  - A second `/send` on any non-draft broadcast → 422 ("Only draft broadcasts can be sent or scheduled"), whatever the `Idempotency-Key`. So no double send, but `classifyResendError` reads 422 as `permanent`: probe before you believe it (`_probe-refused-send.ts`).
  - Against a deleted audience, `POST /broadcasts` → 404 "Audience not found" and `POST /contacts/imports` → 404 "Segment not found", while GET of its old import still says `completed`.
  - `failed` and `scheduled` are real broadcast statuses; `normaliseStatus` reads both as `unknown`, so they are refused fail-closed. A `cancelled` inherited id is dead on the import leg (only a draft can be sent) and is re-minted.
- SLO budgets are still **UNVERIFIED** against prod RUM: compose TTFB <600 ms · submit <1.2 s · queue <500 ms @1k · approve&send <1.5 s · webhook <250 ms · unsubscribe <400 ms.
