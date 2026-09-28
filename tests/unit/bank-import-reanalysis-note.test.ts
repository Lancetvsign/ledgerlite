import { describe, expect, it } from 'vitest';

import { reanalysisNote } from '@/app/bank-import/reanalysis-note';
import { MODEL_FAILURE_CODES } from '@/server/bank-import/extract';

/** LL-118: the review says why the AI's re-check could not run — one distinct reason per code. */
describe('reanalysisNote', () => {
  it('explains every failure code, each differently, and points at re-uploading or correcting', () => {
    const notes = MODEL_FAILURE_CODES.map((c) => reanalysisNote(c));
    for (const [i, n] of notes.entries()) {
      expect(n, MODEL_FAILURE_CODES[i]).toMatch(/^The AI tried to re-check this statement, but .+\. Uploading it again later/);
    }
    expect(new Set(notes).size).toBe(MODEL_FAILURE_CODES.length);
    expect(reanalysisNote('EXTRACTION_RATE_LIMITED')).toContain('busy');
  });

  it('says nothing when no re-check failed, or for a value it does not know', () => {
    expect(reanalysisNote(null)).toBeNull();
    expect(reanalysisNote('SOMETHING_ELSE')).toBeNull();
    expect(reanalysisNote('toString')).toBeNull();
  });
});
