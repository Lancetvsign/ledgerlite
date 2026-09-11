/**
 * AI statement extractor — LL-076b. The model is MOCKED (`ai/test`), so this proves the
 * seam's contract without a network call: PDF text → structured model output → rows;
 * a scan is rejected before any model call; a failed/malformed model response surfaces as
 * EXTRACTION_FAILED carrying no model output or file text (§9); environment resolution.
 */
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BankImportError } from '@/server/bank-import/errors';
import { cannedExtractor, createAiExtractor, describeExtractionRoute, isExtractionConfigured, notConfiguredExtractor, resolveExtractor } from '@/server/bank-import/extract';
import { extractPdfText } from '@/server/bank-import/pdf-text';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

/** A mock model that answers every call with the given text (JSON for structured output). */
function modelSaying(text: string): { model: MockLanguageModelV4; calls: () => number } {
  let n = 0;
  const model = new MockLanguageModelV4({
    doGenerate: () => {
      n += 1;
      return Promise.resolve({
        content: [{ type: 'text' as const, text }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage,
        warnings: [],
      });
    },
  });
  return { model, calls: () => n };
}

const STATEMENT_TEXT = 'ACME BANK Statement 2026-06-01 to 2026-06-30. 06/01 DEPOSIT ACME CORP 1,500.00 06/03 OFFICE DEPOT #1234 -120.50';
const readStatement = () => Promise.resolve(STATEMENT_TEXT);
const BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF" — never parsed when readText is injected

const errOf = async (p: Promise<unknown>): Promise<BankImportError> => {
  try {
    await p;
    throw new Error('expected BankImportError');
  } catch (e) {
    expect(e).toBeInstanceOf(BankImportError);
    return e as BankImportError;
  }
};

describe('createAiExtractor', () => {
  it('returns the model’s transactions with amounts as signed strings', async () => {
    const { model } = modelSaying(
      JSON.stringify({
        transactions: [
          { date: '2026-06-01', description: 'DEPOSIT ACME CORP', amount: '1500.00', category: 'Sales Revenue' },
          { date: '2026-06-03', description: 'OFFICE DEPOT #1234', amount: '-120.50' },
        ],
      }),
    );
    const rows = await createAiExtractor({ model, readText: readStatement })({ bytes: BYTES });
    expect(rows).toEqual([
      { date: '2026-06-01', description: 'DEPOSIT ACME CORP', amount: '1500.00', category: 'Sales Revenue' },
      { date: '2026-06-03', description: 'OFFICE DEPOT #1234', amount: '-120.50' },
    ]);
    expect(rows.every((r) => typeof r.amount === 'string')).toBe(true); // never a JS number (ADR-004)
  });

  it('rejects a scan before calling the model', async () => {
    const { model, calls } = modelSaying('{"transactions":[]}');
    const scanned = createAiExtractor({ model, readText: () => Promise.reject(new BankImportError('SCANNED_PDF', 'no text layer')) });
    const err = await errOf(scanned({ bytes: BYTES }));
    expect(err.code).toBe('SCANNED_PDF');
    expect(calls()).toBe(0);
  });

  it('surfaces a malformed model response as EXTRACTION_FAILED without leaking the response or the text', async () => {
    const { model } = modelSaying('Sure! Here is the data you asked for: <not json> SECRET-PAYEE-42');
    const err = await errOf(createAiExtractor({ model, readText: readStatement })({ bytes: BYTES }));
    expect(err.code).toBe('EXTRACTION_FAILED');
    expect(err.message).not.toContain('SECRET-PAYEE-42');
    expect(err.message).not.toContain('ACME');
  });

  it('surfaces a provider failure as EXTRACTION_FAILED', async () => {
    const model = new MockLanguageModelV4({ doGenerate: () => Promise.reject(new Error('gateway 503: upstream unavailable; body=ACME')) });
    const err = await errOf(createAiExtractor({ model, readText: readStatement })({ bytes: BYTES }));
    expect(err.code).toBe('EXTRACTION_FAILED');
    expect(err.message).not.toContain('ACME');
  });
});

describe('extractPdfText (pdf.js via unpdf, in memory)', () => {
  it('reads the text layer of a text-based PDF', async () => {
    const text = await extractPdfText(buildPdf('Statement period 2026-06-01 to 2026-06-30 DEPOSIT ACME CORP 1500.00'));
    expect(text).toContain('DEPOSIT ACME CORP 1500.00');
  });

  it('rejects a PDF with no text layer as SCANNED_PDF', async () => {
    const err = await errOf(extractPdfText(buildPdf(null)));
    expect(err.code).toBe('SCANNED_PDF');
  });

  it('rejects bytes that are not a PDF as EXTRACTION_FAILED', async () => {
    const err = await errOf(extractPdfText(new TextEncoder().encode('%PDF-1.4 this is not really a pdf')));
    expect(err.code).toBe('EXTRACTION_FAILED');
  });
});

describe('resolveExtractor / isExtractionConfigured', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is not configured with no credential and no test flag', () => {
    vi.stubEnv('BANK_IMPORT_TEST_EXTRACTOR', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    vi.stubEnv('VERCEL_OIDC_TOKEN', '');
    vi.stubEnv('VERCEL', '');
    expect(describeExtractionRoute()).toBe('none');
    expect(isExtractionConfigured()).toBe(false);
    expect(resolveExtractor()).toBe(notConfiguredExtractor);
  });

  it('a direct Anthropic key wins over the gateway (bypasses gateway tier rules)', () => {
    vi.stubEnv('BANK_IMPORT_TEST_EXTRACTOR', '');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-synthetic-not-a-real-key');
    vi.stubEnv('AI_GATEWAY_API_KEY', 'synthetic-not-a-real-key');
    vi.stubEnv('VERCEL', '1');
    expect(describeExtractionRoute()).toBe('anthropic');
    expect(isExtractionConfigured()).toBe(true);
    expect(resolveExtractor()).not.toBe(cannedExtractor);
    expect(resolveExtractor()).not.toBe(notConfiguredExtractor);
  });

  it('uses the canned extractor when the test flag is set, even with credentials', () => {
    vi.stubEnv('BANK_IMPORT_TEST_EXTRACTOR', '1');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-synthetic-not-a-real-key');
    vi.stubEnv('AI_GATEWAY_API_KEY', 'synthetic-not-a-real-key');
    expect(describeExtractionRoute()).toBe('test');
    expect(isExtractionConfigured()).toBe(true);
    expect(resolveExtractor()).toBe(cannedExtractor);
  });

  it('uses the AI extractor with a gateway key or on Vercel (OIDC)', () => {
    vi.stubEnv('BANK_IMPORT_TEST_EXTRACTOR', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('AI_GATEWAY_API_KEY', 'synthetic-not-a-real-key');
    expect(describeExtractionRoute()).toBe('gateway');
    expect(isExtractionConfigured()).toBe(true);
    expect(resolveExtractor()).not.toBe(cannedExtractor);
    expect(resolveExtractor()).not.toBe(notConfiguredExtractor);

    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    vi.stubEnv('VERCEL_OIDC_TOKEN', '');
    vi.stubEnv('VERCEL', '1');
    expect(isExtractionConfigured()).toBe(true);
  });
});

/**
 * A minimal single-page PDF with (or without) a text object, with a correct xref table so
 * pdf.js parses it without reconstruction. Synthetic test data only.
 */
function buildPdf(text: string | null): Uint8Array {
  const content = text === null ? '' : `BT /F1 12 Tf 40 700 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${String(i + 1)} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const o of offsets) body += `${o.toString().padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xrefAt)}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, 'latin1'));
}
