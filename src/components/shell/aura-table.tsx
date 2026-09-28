'use client';

/**
 * Spec 122 — AURA's semantic table for Server Components.
 *
 * Everything at the `@jirawatpyk/aura-react` root is a client module, and a
 * server file may not import it (`aura-server-imports.test.ts`). This client
 * module re-exports the table parts so a server page can render them with
 * server-built children (links, money formatted on the server, client
 * buttons): the parts become client references, their children stay RSC.
 * `stackBelow` turns rows into cards in CSS, with table semantics kept.
 */
export { Table, THead, TBody, Tr, Th, Td } from '@jirawatpyk/aura-react';
