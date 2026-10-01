/**
 * AI statement extractor — LL-076b. The model is MOCKED (`ai/test`), so this proves the
 * seam's contract without a network call: PDF text → structured model output → rows;
 * a scan is rejected before any model call; a failed/malformed model response surfaces as
 * EXTRACTION_FAILED carrying no model output or file text (§9); environment resolution.
 */
import { APICallError, RetryError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BankImportError } from '@/server/bank-import/errors';
import { buildContextPrompt, cannedExtractor, classifyModelFailure, createAiExtractor, DEFAULT_BANK_IMPORT_MODEL, describeExtractionRoute, isExtractionConfigured, notConfiguredExtractor, resolveExtractor, toExtractionOutput } from '@/server/bank-import/extract';
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

const STATEMENT_TEXT = 'ACME BANK Statement 2026-06-01 to 2026-06-30. Beginning Balance $5,000.00 Total Deposits 1,500.00 Total Withdrawals 120.50 Ending Balance 6,379.50 06/01 DEPOSIT ACME CORP 1,500.00 06/03 OFFICE DEPOT #1234 -120.50';
/** LL-123: the model reports the account summary as labelled lines, exactly as printed. */
const SUMMARY_5000 = {
  figures: [
    { label: 'Beginning Balance', amount: '$5,000.00' },
    { label: 'Total Deposits', amount: '1,500.00' },
    { label: 'Total Withdrawals', amount: '120.50' },
    { label: 'Ending Balance', amount: '6,379.50' },
  ],
};
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
    const out = toExtractionOutput(await createAiExtractor({ model, readText: readStatement })({ bytes: BYTES }));
    expect(out.transactions).toEqual([
      { date: '2026-06-01', description: 'DEPOSIT ACME CORP', amount: '1500.00', category: 'Sales Revenue' },
      { date: '2026-06-03', description: 'OFFICE DEPOT #1234', amount: '-120.50' },
    ]);
    expect(out.transactions.every((r) => typeof r.amount === 'string')).toBe(true); // never a JS number (ADR-004)
    expect(out.summary).toBeUndefined(); // no summary reported: nothing to check (LL-109)…
    expect(out.attempts).toBe(2); // …but every statement prints its balances, so it is asked for once (LL-123)
  });

  it('reads the statement\'s own totals, normalises their notation, and accepts a first pass that reconciles (LL-109)', async () => {
    const { model, calls } = modelSaying(
      JSON.stringify({
        summary: SUMMARY_5000,
        transactions: [
          { date: '2026-06-01', description: 'DEPOSIT ACME CORP', amount: '1500.00' },
          { date: '2026-06-03', description: 'OFFICE DEPOT #1234', amount: '-120.50' },
        ],
      }),
    );
    const out = toExtractionOutput(await createAiExtractor({ model, readText: readStatement })({ bytes: BYTES }));
    expect(out.summary).toEqual({ beginningBalance: '5000.0000', totalCredits: '1500.0000', totalDebits: '120.5000', endingBalance: '6379.5000' });
    expect(out.figures?.map((f) => [f.role, f.found])).toEqual([['beginning', true], ['money_in', true], ['money_out', true], ['ending', true]]);
    expect(out.attempts).toBe(1);
    expect(calls()).toBe(1); // it reconciled: no second pass
  });

  it('re-analyses ONCE when the lines do not add up to the statement\'s totals, feeding back figures only, and keeps the pass that reconciles', async () => {
    const answers = [
      // First pass: the deposit misread as 1,050.00 — credits off by 450, ending off by 450.
      JSON.stringify({
        summary: SUMMARY_5000,
        transactions: [{ date: '2026-06-01', description: 'DEPOSIT ACME CORP', amount: '1050.00' }, { date: '2026-06-03', description: 'OFFICE DEPOT #1234', amount: '-120.50' }],
      }),
      JSON.stringify({
        summary: SUMMARY_5000,
        transactions: [{ date: '2026-06-01', description: 'DEPOSIT ACME CORP', amount: '1500.00' }, { date: '2026-06-03', description: 'OFFICE DEPOT #1234', amount: '-120.50' }],
      }),
    ];
    const prompts: string[] = [];
    let n = 0;
    const model = new MockLanguageModelV4({
      doGenerate: (options) => {
        prompts.push(JSON.stringify(options.prompt));
        const text = answers[n] ?? answers[answers.length - 1]!;
        n += 1;
        return Promise.resolve({ content: [{ type: 'text' as const, text }], finishReason: { unified: 'stop' as const, raw: undefined }, usage, warnings: [] });
      },
    });
    const out = toExtractionOutput(await createAiExtractor({ model, readText: readStatement })({ bytes: BYTES }));
    expect(n).toBe(2);
    expect(out.attempts).toBe(2);
    expect(out.transactions[0]!.amount).toBe('1500.00'); // the reconciling pass won
    expect(out.reanalysisFailure).toBeUndefined(); // the re-check ran
    // The feedback carries the discrepancy as figures (statement vs lines, difference) and the original
    // statement text — never the model's rows themselves.
    expect(prompts[1]).toContain('did not hold together');
    expect(prompts[1]).toContain('-450.0000');
    expect(prompts[1]).not.toContain('"transactions"');
    expect(prompts[1]).not.toContain('OFFICE DEPOT #1234", "amount"');
  });

  it('after two passes that both fail to reconcile, the second is returned with attempts 2 — the review shows the gap', async () => {
    const { model, calls } = modelSaying(
      JSON.stringify({
        summary: SUMMARY_5000,
        transactions: [{ date: '2026-06-01', description: 'DEPOSIT ACME CORP', amount: '1050.00' }, { date: '2026-06-03', description: 'OFFICE DEPOT #1234', amount: '-120.50' }],
      }),
    );
    const out = toExtractionOutput(await createAiExtractor({ model, readText: readStatement })({ bytes: BYTES }));
    expect(calls()).toBe(2);
    expect(out.attempts).toBe(2);
    expect(out.transactions[0]!.amount).toBe('1050.00');
  });

  it('LL-114: when the re-analysis fails, the first pass is staged with its gap — a service failure or an unusable answer', async () => {
    const MISMATCHED = JSON.stringify({
      summary: SUMMARY_5000,
      transactions: [{ date: '2026-06-01', description: 'DEPOSIT ACME CORP', amount: '1050.00' }, { date: '2026-06-03', description: 'OFFICE DEPOT #1234', amount: '-120.50' }],
    });
    const answer = (text: string) => Promise.resolve({ content: [{ type: 'text' as const, text }], finishReason: { unified: 'stop' as const, raw: undefined }, usage, warnings: [] });
    const failingSecond = (second: () => ReturnType<typeof answer>) => {
      let n = 0;
      const model = new MockLanguageModelV4({ doGenerate: () => (++n === 1 ? answer(MISMATCHED) : second()) });
      return { model, calls: () => n };
    };

    // The AI service is unavailable on the second call (a non-retryable 529 so the SDK does not back off).
    const down = failingSecond(() => Promise.reject(apiError(529, 'overloaded')));
    const out = toExtractionOutput(await createAiExtractor({ model: down.model, readText: readStatement })({ bytes: BYTES }));
    expect(down.calls()).toBe(2);
    expect(out.attempts).toBe(1);
    expect(out.transactions.map((t) => t.amount)).toEqual(['1050.00', '-120.50']);
    expect(out.summary?.endingBalance).toBe('6379.5000');
    expect(out.reanalysisFailure).toBe('EXTRACTION_SERVICE_UNAVAILABLE'); // LL-118: recorded for the review

    // The second call answers with something unusable.
    const garbled = failingSecond(() => answer('not json'));
    const out2 = toExtractionOutput(await createAiExtractor({ model: garbled.model, readText: readStatement })({ bytes: BYTES }));
    expect(garbled.calls()).toBe(2);
    expect(out2.attempts).toBe(1);
    expect(out2.transactions[0]!.amount).toBe('1050.00');
    expect(out2.reanalysisFailure).toBe('EXTRACTION_FAILED');
  });

  it('LL-114: a failure on the FIRST call still fails the upload with its own code — there is nothing to keep', async () => {
    const model = new MockLanguageModelV4({ doGenerate: () => Promise.reject(apiError(401, 'invalid x-api-key')) });
    const err = await errOf(createAiExtractor({ model, readText: readStatement })({ bytes: BYTES }));
    expect(err.code).toBe('EXTRACTION_KEY_REJECTED');
  });

  describe('LL-127: effort and the time budget', () => {
    const MISMATCHED = JSON.stringify({
      summary: SUMMARY_5000,
      transactions: [{ date: '2026-06-01', description: 'DEPOSIT ACME CORP', amount: '1050.00' }, { date: '2026-06-03', description: 'OFFICE DEPOT #1234', amount: '-120.50' }],
    });
    const answer = (text: string) => Promise.resolve({ content: [{ type: 'text' as const, text }], finishReason: { unified: 'stop' as const, raw: undefined }, usage, warnings: [] });
    /** A model call that never answers; it ends only when the caller's abort signal fires. */
    const hangsUntilAborted = (signal: AbortSignal | undefined) =>
      new Promise<never>((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError'))));

    it('asks the model for LOW effort where the model accepts one, and sends none where it would be rejected', async () => {
      const seen: unknown[] = [];
      const withId = (modelId: string) =>
        new MockLanguageModelV4({
          modelId,
          doGenerate: (options) => {
            seen.push((options.providerOptions as { anthropic?: { effort?: string } } | undefined)?.anthropic?.effort);
            return answer(JSON.stringify({ summary: SUMMARY_5000, transactions: [{ date: '2026-06-01', description: 'DEPOSIT ACME CORP', amount: '1500.00' }, { date: '2026-06-03', description: 'OFFICE DEPOT #1234', amount: '-120.50' }] }));
          },
        });
      await createAiExtractor({ model: withId('claude-sonnet-5'), readText: readStatement })({ bytes: BYTES });
      await createAiExtractor({ model: withId('claude-sonnet-5-5'), readText: readStatement })({ bytes: BYTES });
      await createAiExtractor({ model: withId('claude-haiku-4-5'), readText: readStatement })({ bytes: BYTES });
      await createAiExtractor({ model: withId('claude-sonnet-4-5'), readText: readStatement })({ bytes: BYTES });
      expect(seen).toEqual(['low', 'low', undefined, undefined]);
    });

    it('LL-128: OpenAI models get low reasoning effort (reasoning models only) and are not forced into strict JSON-schema mode', async () => {
      const seen: unknown[] = [];
      const withId = (modelId: string) =>
        new MockLanguageModelV4({
          modelId,
          doGenerate: (options) => {
            seen.push(options.providerOptions);
            return answer(JSON.stringify({ summary: SUMMARY_5000, transactions: [{ date: '2026-06-01', description: 'DEPOSIT ACME CORP', amount: '1500.00' }, { date: '2026-06-03', description: 'OFFICE DEPOT #1234', amount: '-120.50' }] }));
          },
        });
      for (const id of ['openai/gpt-5.6-sol', 'openai/gpt-6.1-sol', 'openai/o4-mini', 'openai/gpt-4o', 'google/gemini-x']) {
        await createAiExtractor({ model: withId(id), readText: readStatement })({ bytes: BYTES });
      }
      expect(seen).toEqual([
        { openai: { strictJsonSchema: false, reasoningEffort: 'low' } },
        { openai: { strictJsonSchema: false, reasoningEffort: 'low' } },
        { openai: { strictJsonSchema: false, reasoningEffort: 'low' } },
        { openai: { strictJsonSchema: false } }, // a non-reasoning chat model would 400 on reasoningEffort
        undefined, // another provider: nothing Anthropic- or OpenAI-specific is sent
      ]);
    });

    it('a FIRST pass that outlasts the budget is aborted and fails the upload with EXTRACTION_TIMED_OUT — no second call, no crash page', async () => {
      let calls = 0;
      const model = new MockLanguageModelV4({ doGenerate: (options) => { calls += 1; return hangsUntilAborted(options.abortSignal); } });
      const err = await errOf(createAiExtractor({ model, readText: readStatement, budgetMs: 40 })({ bytes: BYTES }));
      expect(err.code).toBe('EXTRACTION_TIMED_OUT');
      expect(err.message).not.toContain('DEPOSIT'); // §9: no statement text
      expect(calls).toBe(1);
    });

    it('with too little time left for a re-check, the first pass is staged with its gap and the reason is recorded', async () => {
      let calls = 0;
      const model = new MockLanguageModelV4({ doGenerate: () => { calls += 1; return answer(MISMATCHED); } });
      // 5 s budget but a re-check needs 60 s: never started.
      const out = toExtractionOutput(await createAiExtractor({ model, readText: readStatement, budgetMs: 5_000 })({ bytes: BYTES }));
      expect(calls).toBe(1);
      expect(out.attempts).toBe(1);
      expect(out.transactions[0]!.amount).toBe('1050.00');
      expect(out.reanalysisFailure).toBe('EXTRACTION_TIMED_OUT');
    });

    it('a re-check cut off by the budget keeps the first pass, recorded as timed out', async () => {
      let calls = 0;
      const model = new MockLanguageModelV4({ doGenerate: (options) => (++calls === 1 ? answer(MISMATCHED) : hangsUntilAborted(options.abortSignal)) });
      const out = toExtractionOutput(await createAiExtractor({ model, readText: readStatement, budgetMs: 300, minRecheckMs: 50 })({ bytes: BYTES }));
      expect(calls).toBe(2);
      expect(out.attempts).toBe(1);
      expect(out.transactions[0]!.amount).toBe('1050.00');
      expect(out.reanalysisFailure).toBe('EXTRACTION_TIMED_OUT');
    });

    it('a timeout is not confused with a service failure: status-based classification is unchanged', () => {
      expect(classifyModelFailure(new DOMException('aborted', 'AbortError'))).toBe('EXTRACTION_FAILED');
    });
  });

  it('never throws on a malformed figure: a bad row or summary is left for staging to report (LL-109); a figure not on the statement asks for one re-read (LL-123)', async () => {
    const { model, calls } = modelSaying(
      JSON.stringify({
        summary: { figures: [{ label: 'Beginning Balance', amount: 'lots' }, { label: 'Total Deposits', amount: '1,500.00' }] },
        transactions: [{ date: '2026-06-01', description: 'DEPOSIT ACME CORP', amount: 'one thousand' }],
      }),
    );
    const out = toExtractionOutput(await createAiExtractor({ model, readText: readStatement })({ bytes: BYTES }));
    expect(calls()).toBe(2); // "lots" is not on the statement and the ending balance is missing: one re-read
    expect(out.transactions[0]!.amount).toBe('one thousand'); // stageImport's validator rejects it, with a field path only
    expect(out.figures?.map((f) => f.found)).toEqual([false, true]);
    expect(out.summary).toEqual({ totalCredits: '1500.0000' }); // the unreadable balance is not counted
    expect(out.attempts).toBe(2);
  });

  it('LL-123: the owner\'s statement — roles come from the labels, and a summary that does not add up is re-read with the gap', async () => {
    const ownerText = 'ACCOUNT SUMMARY Previous Balance $3,814.15 Total Deposits 9,800.00 Total Checks and Debits 9,554.08 Other Credits 27.00 Balance This Statement $4,087.07 05/02 DEPOSIT 9,800.00 05/15 INTEREST 27.00 05/20 CHECKS 9,554.08';
    const rows = [
      { date: '2025-05-02', description: 'DEPOSIT', amount: '9800.00' },
      { date: '2025-05-15', description: 'INTEREST', amount: '27.00' },
      { date: '2025-05-20', description: 'CHECKS', amount: '-9554.08' },
    ];
    const answers = [
      // First pass: the model's roles are swapped (the labels override them) and "Other Credits" is missed.
      JSON.stringify({ summary: { figures: [
        { label: 'Previous Balance', amount: '3,814.15', role: 'money_in' },
        { label: 'Total Deposits', amount: '9,800.00', role: 'beginning' },
        { label: 'Total Checks and Debits', amount: '9,554.08', role: 'ending' },
        { label: 'Balance This Statement', amount: '4,087.07', role: 'money_out' },
      ] }, transactions: rows }),
      JSON.stringify({ summary: { figures: [
        { label: 'Previous Balance', amount: '3,814.15' },
        { label: 'Total Deposits', amount: '9,800.00' },
        { label: 'Other Credits', amount: '27.00' },
        { label: 'Total Checks and Debits', amount: '9,554.08' },
        { label: 'Balance This Statement', amount: '4,087.07' },
      ] }, transactions: rows }),
    ];
    const prompts: string[] = [];
    let n = 0;
    const model = new MockLanguageModelV4({
      doGenerate: (options) => {
        prompts.push(JSON.stringify(options.prompt));
        const text = answers[n] ?? answers[answers.length - 1]!;
        n += 1;
        return Promise.resolve({ content: [{ type: 'text' as const, text }], finishReason: { unified: 'stop' as const, raw: undefined }, usage, warnings: [] });
      },
    });
    const out = toExtractionOutput(await createAiExtractor({ model, readText: () => Promise.resolve(ownerText) })({ bytes: BYTES }));
    expect(n).toBe(2);
    expect(prompts[1]).toContain('The summary does not add up');
    expect(prompts[1]).toContain('4060.0700'); // beginning + in − out on the first pass
    expect(prompts[1]).toContain('-27.0000');
    expect(out.summary).toEqual({ beginningBalance: '3814.1500', totalCredits: '9827.0000', totalDebits: '9554.0800', endingBalance: '4087.0700' });
    expect(out.attempts).toBe(2);
  });

  it('LL-123: a statement summary without an ending balance is re-read', async () => {
    const { model, calls } = modelSaying(JSON.stringify({
      summary: { figures: [{ label: 'Beginning Balance', amount: '$5,000.00' }, { label: 'Total Deposits', amount: '1,500.00' }, { label: 'Total Withdrawals', amount: '120.50' }] },
      transactions: [{ date: '2026-06-01', description: 'DEPOSIT ACME CORP', amount: '1500.00' }, { date: '2026-06-03', description: 'OFFICE DEPOT #1234', amount: '-120.50' }],
    }));
    const out = toExtractionOutput(await createAiExtractor({ model, readText: readStatement })({ bytes: BYTES }));
    expect(calls()).toBe(2);
    expect(out.summary?.endingBalance).toBeUndefined();
  });

  it('reads the statement\'s printed closing date and normalises its notation (LL-111)', async () => {
    const { model } = modelSaying(
      JSON.stringify({
        summary: { ...SUMMARY_5000, statementDate: '06/30/2026' },
        transactions: [{ date: '2026-06-01', description: 'DEPOSIT', amount: '1500.00' }, { date: '2026-06-03', description: 'OFFICE DEPOT', amount: '-120.50' }],
      }),
    );
    const out = toExtractionOutput(await createAiExtractor({ model, readText: readStatement })({ bytes: BYTES }));
    expect(out.summary?.statementDate).toBe('2026-06-30');
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

/** An API error as the provider SDK raises it; the body stands in for anything the provider sent. */
const apiError = (statusCode: number | undefined, message = 'provider said no', isRetryable = false): APICallError =>
  new APICallError({ message, url: 'https://api.example.test/v1/messages', requestBodyValues: {}, ...(statusCode === undefined ? {} : { statusCode }), isRetryable, responseBody: 'body=ACME' });

describe('classifyModelFailure (LL-113): the AI service, or the statement', () => {
  it('names the service problem from the status, never the statement', () => {
    expect(classifyModelFailure(apiError(401))).toBe('EXTRACTION_KEY_REJECTED');
    expect(classifyModelFailure(apiError(403))).toBe('EXTRACTION_KEY_REJECTED');
    expect(classifyModelFailure(apiError(402))).toBe('EXTRACTION_OUT_OF_CREDIT');
    expect(classifyModelFailure(apiError(404))).toBe('EXTRACTION_MODEL_UNAVAILABLE');
    expect(classifyModelFailure(apiError(429))).toBe('EXTRACTION_RATE_LIMITED');
    for (const s of [500, 502, 503, 529]) expect(classifyModelFailure(apiError(s)), String(s)).toBe('EXTRACTION_SERVICE_UNAVAILABLE');
  });

  it('recognises the providers\' credit refusals whatever their status', () => {
    expect(classifyModelFailure(apiError(400, 'Your credit balance is too low to access the Anthropic API.'))).toBe('EXTRACTION_OUT_OF_CREDIT');
    expect(classifyModelFailure(apiError(429, 'You exceeded your current quota (insufficient_quota).'))).toBe('EXTRACTION_OUT_OF_CREDIT');
    // LL-128: the gateway's free tier refuses a paid model with a 403 — credits, not a rejected key.
    expect(classifyModelFailure(apiError(403, 'Free tier users do not have access to this model'))).toBe('EXTRACTION_OUT_OF_CREDIT');
    expect(classifyModelFailure(apiError(403, 'Forbidden'))).toBe('EXTRACTION_KEY_REJECTED');
    // A 400 that merely echoes statement text mentioning billing is still the statement's problem.
    expect(classifyModelFailure(apiError(400, 'invalid request near "BILLING STATEMENT — CREDIT BALANCE"'))).toBe('EXTRACTION_FAILED');
  });

  it('judges a retried failure by its last attempt; an unreachable service is unavailable', () => {
    const retried = new RetryError({ message: 'Failed after 3 attempts', reason: 'maxRetriesExceeded', errors: [apiError(529, 'overloaded', true), apiError(529, 'overloaded', true), apiError(429, 'slow down', true)] });
    expect(classifyModelFailure(retried)).toBe('EXTRACTION_RATE_LIMITED');
    expect(classifyModelFailure(apiError(undefined, 'fetch failed', true))).toBe('EXTRACTION_SERVICE_UNAVAILABLE');
  });

  it('leaves everything else as the statement\'s problem', () => {
    expect(classifyModelFailure(apiError(400))).toBe('EXTRACTION_FAILED');
    expect(classifyModelFailure(apiError(422))).toBe('EXTRACTION_FAILED');
    expect(classifyModelFailure(apiError(undefined, 'no response', false))).toBe('EXTRACTION_FAILED');
    expect(classifyModelFailure(new Error('gateway 503: upstream unavailable'))).toBe('EXTRACTION_FAILED'); // no status, not an API error
    expect(classifyModelFailure('boom')).toBe('EXTRACTION_FAILED');
  });

  it('the extractor raises the service code with its own message — never the provider\'s text or the statement\'s', async () => {
    const model = new MockLanguageModelV4({ doGenerate: () => Promise.reject(apiError(401, 'invalid x-api-key: sk-ant-SECRET')) });
    const err = await errOf(createAiExtractor({ model, readText: readStatement })({ bytes: BYTES }));
    expect(err.code).toBe('EXTRACTION_KEY_REJECTED');
    expect(err.message).not.toContain('SECRET');
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

  it('LL-128: the default model is GPT-5.6 Sol, read through the gateway — a leftover Anthropic key does not capture it', () => {
    expect(DEFAULT_BANK_IMPORT_MODEL).toBe('openai/gpt-5.6-sol');
    vi.stubEnv('BANK_IMPORT_TEST_EXTRACTOR', '');
    vi.stubEnv('BANK_IMPORT_MODEL', '');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-synthetic-not-a-real-key');
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    vi.stubEnv('VERCEL_OIDC_TOKEN', '');
    vi.stubEnv('VERCEL', '1'); // Vercel: the deployment's OIDC token reaches the gateway
    expect(describeExtractionRoute()).toBe('gateway');
    expect(isExtractionConfigured()).toBe(true);
    // Locally with the Anthropic key but no gateway credential: the OpenAI model has nothing to reach it with.
    vi.stubEnv('VERCEL', '');
    expect(describeExtractionRoute()).toBe('none');
    expect(isExtractionConfigured()).toBe(false);
  });

  it('a direct Anthropic key is used when an Anthropic model is chosen (bypasses gateway tier rules)', () => {
    vi.stubEnv('BANK_IMPORT_TEST_EXTRACTOR', '');
    vi.stubEnv('BANK_IMPORT_MODEL', 'anthropic/claude-sonnet-5');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-synthetic-not-a-real-key');
    vi.stubEnv('AI_GATEWAY_API_KEY', 'synthetic-not-a-real-key');
    vi.stubEnv('VERCEL', '1');
    expect(describeExtractionRoute()).toBe('anthropic');
    expect(isExtractionConfigured()).toBe(true);
    expect(resolveExtractor()).not.toBe(cannedExtractor);
    expect(resolveExtractor()).not.toBe(notConfiguredExtractor);
    // An Anthropic model without its key goes through the gateway instead.
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    expect(describeExtractionRoute()).toBe('gateway');
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

describe('chart-aware prompt (LL-080)', () => {
  it('lists the company chart and its past decisions, and nothing else about the company', () => {
    const text = buildContextPrompt({
      accounts: [{ number: '6300', name: 'Office Supplies', type: 'EXPENSE' }, { number: null, name: 'Consulting Sales', type: 'REVENUE' }],
      examples: [{ description: 'OFFICE DEPOT #1234', account: 'Office Supplies' }],
    });
    expect(text).toContain('- 6300 Office Supplies (EXPENSE)');
    expect(text).toContain('- Consulting Sales (REVENUE)');
    expect(text).toContain('"OFFICE DEPOT #1234" → Office Supplies');
    expect(buildContextPrompt(undefined)).toBe('');
    expect(buildContextPrompt({ accounts: [], examples: [] })).toBe('');
  });

  it('tells the model when the statement is a credit card, so charges are money OUT (LL-088)', () => {
    const card = buildContextPrompt({ accounts: [], examples: [], statementKind: 'credit_card' });
    expect(card).toContain('CREDIT CARD statement');
    expect(card).toMatch(/purchases.*money OUT/i);
    expect(card).toMatch(/payments.*money IN/i);
    expect(buildContextPrompt({ accounts: [], examples: [], statementKind: 'bank' })).toBe('');
  });

  it('the model call carries the chart and examples in its prompt', async () => {
    let prompt = '';
    const model = new MockLanguageModelV4({
      doGenerate: (options) => {
        prompt = JSON.stringify(options.prompt);
        return Promise.resolve({
          content: [{ type: 'text' as const, text: '{"transactions":[]}' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage,
          warnings: [],
        });
      },
    });
    await createAiExtractor({ model, readText: readStatement })({
      bytes: BYTES,
      context: { accounts: [{ number: '6300', name: 'Office Supplies', type: 'EXPENSE' }], examples: [{ description: 'OFFICE DEPOT #1234', account: 'Office Supplies' }] },
    });
    expect(prompt).toContain('6300 Office Supplies (EXPENSE)');
    expect(prompt).toContain('OFFICE DEPOT #1234');
    expect(prompt).toContain('ACME BANK Statement'); // the statement text still follows
  });
});

