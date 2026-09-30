import type { ModelFailureCode } from '@/server/bank-import';

/**
 * LL-118: why the AI's re-check of a mismatched statement could not run, in the reviewer's terms —
 * a plain module (not the page, not a client module) so it is unit-tested. The first reading was
 * kept (LL-114); uploading again later may give one that adds up.
 */
const REASON: Record<ModelFailureCode, string> = {
  EXTRACTION_SERVICE_UNAVAILABLE: 'the AI service was unavailable',
  EXTRACTION_RATE_LIMITED: 'the AI service was busy',
  EXTRACTION_KEY_REJECTED: 'the AI service rejected this app’s API key',
  EXTRACTION_OUT_OF_CREDIT: 'the AI service account was out of credit',
  EXTRACTION_MODEL_UNAVAILABLE: 'the configured AI model was not found',
  EXTRACTION_FAILED: 'its second answer could not be used',
  EXTRACTION_TIMED_OUT: 'it ran out of time',
};

export function reanalysisNote(code: string | null): string | null {
  if (code === null || !Object.hasOwn(REASON, code)) return null;
  return `The AI tried to re-check this statement, but ${REASON[code as ModelFailureCode]}. Uploading it again later may give a reading that adds up — or correct the lines here.`;
}
