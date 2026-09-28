/**
 * The upload page's notice for an `?error=` code — a plain module (not the page, not a client
 * module) so it can be unit-tested. LL-113 separates "the statement could not be read" from "the
 * AI service could not be reached or refused this app", which need different fixes.
 */
export function uploadNoticeFrom(error: string | undefined): string | null {
  if (error === undefined) return null;
  if (error === 'invalid_file') return 'Please choose a PDF statement under 10 MB.';
  if (error === 'invalid') return 'Please choose a bank account and a PDF, then try again.';
  if (error === 'EXTRACTION_NOT_CONFIGURED') return 'Statement extraction is not configured yet.';
  if (error === 'EXTRACTION_FAILED') return 'No usable transactions could be extracted from that statement.';
  // LL-113: the AI service, not the statement — say so, and what fixes it.
  if (error === 'EXTRACTION_KEY_REJECTED') return 'The AI service that reads statements rejected this app’s API key. Your statement is not the problem: an administrator needs to replace the key in the deployment settings and redeploy, then upload it again.';
  if (error === 'EXTRACTION_OUT_OF_CREDIT') return 'The AI service account that reads statements is out of credit. Your statement is not the problem: add credit to the account, then upload it again.';
  if (error === 'EXTRACTION_MODEL_UNAVAILABLE') return 'The AI model configured for reading statements was not found. Your statement is not the problem: an administrator needs to check the model setting.';
  if (error === 'EXTRACTION_RATE_LIMITED') return 'The AI service that reads statements is busy right now. Your statement is not the problem: wait a minute, then upload it again.';
  if (error === 'EXTRACTION_SERVICE_UNAVAILABLE') return 'The AI service that reads statements is temporarily unavailable. Your statement is not the problem: try again in a few minutes.';
  if (error === 'SCANNED_PDF') return 'That PDF appears to be a scanned image; a text-based statement is needed.';
  if (error === 'INVALID_BANK_ACCOUNT') return 'Choose an active bank account or credit card.';
  if (error === 'ONLY_CARDS_SHAREABLE') return 'Only a credit-card statement can be shared with the organization — upload it without sharing, or choose the card account.';
  if (error === 'NOT_IN_ORGANIZATION') return 'Put this company in an organization (Account page) before sharing a statement.';
  if (error === 'BATCH_NOT_FOUND') return 'That import batch does not exist.';
  if (error === 'denied') return 'You do not have permission to import statements.';
  return 'The statement could not be imported.';
}
