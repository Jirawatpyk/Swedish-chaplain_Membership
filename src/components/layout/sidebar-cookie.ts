/**
 * The staff rail's cookie (`true` = expanded). A plain module on purpose: the
 * server layout reads it, and a value imported from a `'use client'` file
 * reaches a server component as a client reference, not as the string.
 */
export const SIDEBAR_COOKIE = 'sidebar_state';
export const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
