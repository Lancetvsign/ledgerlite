import 'server-only';

import { extractText } from 'unpdf';

import { BankImportError } from './errors';

/**
 * PDF text-layer extraction — LL-076b. Reads the statement's embedded text locally (pdf.js
 * via `unpdf`, in memory; the bytes are never persisted) so that only TEXT is sent on to
 * the model, never the binary. A PDF with no usable text layer is a scan (or an image
 * export) and is rejected up front as SCANNED_PDF: v1 is text-based statements only
 * (ADR-034); OCR/vision is a follow-up.
 */

/** Below this many non-whitespace characters, the "text layer" is noise, not a statement. */
const MIN_TEXT_CHARS = 40;

/**
 * Cap what is sent to the model — a statement is a few thousand characters per page, so this
 * is ~50+ pages. Over the cap the import is REFUSED rather than truncated: silently dropping
 * the tail of a statement would lose transactions, which is worse than asking for a shorter
 * export.
 */
const MAX_TEXT_CHARS = 200_000;

export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  let text: string;
  try {
    // A fresh copy: pdf.js transfers/neuters the buffer it is handed.
    const result = await extractText(new Uint8Array(bytes), { mergePages: true });
    text = result.text;
  } catch {
    // Deliberately no detail from the parser — it can echo file contents (§9).
    throw new BankImportError('EXTRACTION_FAILED', 'The file could not be read as a PDF.');
  }

  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.replace(/\s/g, '').length < MIN_TEXT_CHARS) {
    throw new BankImportError(
      'SCANNED_PDF',
      'This PDF has no text layer (it looks like a scan or an image). A text-based statement export from your bank is needed.',
    );
  }
  if (compact.length > MAX_TEXT_CHARS) {
    throw new BankImportError('EXTRACTION_FAILED', 'This statement is too long to import in one file. Export a shorter period and try again.');
  }
  return compact;
}
