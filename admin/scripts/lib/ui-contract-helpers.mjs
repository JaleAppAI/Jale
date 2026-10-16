// Shared helpers for the admin UI contract checks (scripts/check-ui-*.mjs).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The admin package root (this file lives in admin/scripts/lib/). */
export const root = resolve(import.meta.dirname, '..', '..');

/** A file under the admin root, as text. */
export const read = (path) => readFileSync(resolve(root, path), 'utf8');

/** Literal markup as a pattern: `\s*` between pieces, everything else escaped. */
export const opsSeq = (...pieces) =>
  new RegExp(pieces.map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'));
