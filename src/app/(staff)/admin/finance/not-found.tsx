/**
 * PR P — `/admin/finance` not-found boundary: the admin "Page not available"
 * page, unchanged. Its presence beside the page (with `force-dynamic`) is
 * what makes a flag-off or refused visit answer HTTP 404 instead of a
 * streamed 200 (R136 follow-up).
 */
export { default } from '../not-found';
