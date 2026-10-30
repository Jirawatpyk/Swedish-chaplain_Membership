/**
 * The one host every Resend call goes to (spec 141).
 *
 * resend@6.35 reads `RESEND_BASE_URL` from the process env when a client is
 * built and sends the Bearer key — and, on contact calls, a member's email —
 * wherever it points. Every `new Resend(…)` passes this as `baseUrl`, so the
 * env var is inert; the Broadcasts gateway's raw-fetch calls use it too.
 */
export const RESEND_API_BASE_URL = 'https://api.resend.com';
