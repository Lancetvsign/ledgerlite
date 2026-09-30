import { describe, expect, it } from 'vitest';

import { uploadNoticeFrom } from '@/app/bank-import/upload-notice';

/** LL-113: an AI-service failure never reads as a problem with the statement. */
describe('upload notices', () => {
  const service = ['EXTRACTION_KEY_REJECTED', 'EXTRACTION_OUT_OF_CREDIT', 'EXTRACTION_MODEL_UNAVAILABLE', 'EXTRACTION_RATE_LIMITED', 'EXTRACTION_SERVICE_UNAVAILABLE'];

  it('says the statement is not the problem for every AI-service failure, each with its own fix', () => {
    const texts = service.map((code) => uploadNoticeFrom(code));
    for (const [i, text] of texts.entries()) {
      expect(text, service[i]).toContain('Your statement is not the problem');
      expect(text, service[i]).not.toContain('No usable transactions');
    }
    expect(new Set(texts).size).toBe(service.length);
    expect(uploadNoticeFrom('EXTRACTION_KEY_REJECTED')).toContain('API key');
    expect(uploadNoticeFrom('EXTRACTION_OUT_OF_CREDIT')).toContain('out of credit');
  });

  it('LL-127: a timed-out read says nothing was imported and to try again — never that the statement had no transactions', () => {
    const text = uploadNoticeFrom('EXTRACTION_TIMED_OUT');
    expect(text).toContain('too long');
    expect(text).toContain('nothing was imported');
    expect(text).not.toContain('No usable transactions');
  });

  it('keeps the statement-side messages as they were', () => {
    expect(uploadNoticeFrom(undefined)).toBeNull();
    expect(uploadNoticeFrom('EXTRACTION_FAILED')).toBe('No usable transactions could be extracted from that statement.');
    expect(uploadNoticeFrom('SCANNED_PDF')).toContain('scanned image');
    expect(uploadNoticeFrom('something-else')).toBe('The statement could not be imported.');
  });
});
