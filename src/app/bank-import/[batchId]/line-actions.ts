/**
 * The review screen's per-line actions — a plain module (no 'use client') so the server page
 * can read a saved draft's action back with `toLineAction` (LL-105): a function exported from a
 * client module cannot be called during server rendering.
 */
export type LineAction = 'post' | 'ignore' | 'apply_invoice' | 'apply_bill' | 'match_transfer' | 'personal' | 'intercompany_transfer' | 'match_intercompany';

export function toLineAction(value: string): LineAction {
  return value === 'ignore' || value === 'apply_invoice' || value === 'apply_bill' || value === 'match_transfer' || value === 'personal' || value === 'intercompany_transfer' || value === 'match_intercompany' ? value : 'post';
}
