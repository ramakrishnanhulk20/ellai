// Checks that a running Ellai site answers a stranger: the landing page, /proof, the docs, the
// app's first screen and the two public JSON reads the pages draw from. Every check must answer
// 200 without a redirect, the pages as HTML and the JSON reads in the exact shape the pages
// expect. Prints one line per check, with counts only, and exits 1 if any check fails.
//   npm run smoke -w packages/web -- https://your-site.vercel.app
// Reads nothing from .env and sends no cookie, so it sees exactly what a first-time visitor sees.
import { z } from 'zod';
import { DECISION_OUTCOMES, DECISION_RULES, MEMORY_KINDS, VERDICTS } from '../src/server/db/schema.js';
import type { MemoryMap, PublicProof } from '../src/server/public/proof.js';

// A dev server compiles a route on its first request, which can take most of a minute.
const TIMEOUT_MS = 90_000;
const PAGES = ['/', '/proof', '/docs', '/docs/how-it-works', '/app'] as const;

const count = z.number().int().nonnegative();
const atomicString = z.string().regex(/^\d+$/);
const isoTime = z.iso.datetime({ offset: true });

const proofSchema: z.ZodType<PublicProof> = z.strictObject({
  totals: z.strictObject({
    verifiedPayments: count,
    verifiedUsdcAtomic: atomicString,
    confirmedOwnerAnswers: count,
    approvedByLearning: count,
    askedDecisions: count,
  }),
  payments: z.array(
    z.strictObject({ digest: z.string().min(1), amountAtomic: atomicString, sellerHost: z.string(), signedAt: isoTime, explorerUrl: z.url({ protocol: /^https$/ }) }),
  ),
  memories: z.array(
    z.strictObject({ blobId: z.string().min(1), kind: z.enum(MEMORY_KINDS), verdict: z.enum(VERDICTS).nullable(), host: z.string().nullable(), confirmedAt: isoTime }),
  ),
});

const memoryMapSchema: z.ZodType<MemoryMap> = z.strictObject({
  generatedAt: isoTime,
  memories: z.array(z.strictObject({ blobId: z.string().min(1), verdict: z.enum(VERDICTS), host: z.string(), amountUsdc: z.string(), at: isoTime })),
  decisions: z.array(
    z.strictObject({
      id: z.string(),
      at: isoTime,
      outcome: z.enum(DECISION_OUTCOMES),
      rule: z.enum(DECISION_RULES),
      host: z.string(),
      amountUsdc: z.string(),
      digest: z.string().nullable(),
      citations: z.array(z.strictObject({ blobId: z.string().min(1), distance: z.number().nullable() })),
    }),
  ),
  totals: z.strictObject({ memories: count, learnedApprovals: count, questionsAsked: count }),
});

interface CheckResult {
  path: string;
  status: string;
  ms: number;
  ok: boolean;
  detail: string;
}

/** The argument as a bare origin, or null when it is anything else. */
function originOf(value: string | undefined): string | null {
  if (value === undefined || !URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
  return url.origin;
}

async function get(origin: string, path: string): Promise<{ response: Response | null; ms: number; failure: string }> {
  const started = Date.now();
  try {
    const response = await fetch(`${origin}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { response, ms: Date.now() - started, failure: '' };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return { response: null, ms: Date.now() - started, failure: timedOut ? `no answer within ${TIMEOUT_MS / 1000} s` : 'could not connect' };
  }
}

async function checkPage(origin: string, path: string): Promise<CheckResult> {
  const { response, ms, failure } = await get(origin, path);
  if (response === null) return { path, status: '-', ms, ok: false, detail: failure };
  const type = response.headers.get('content-type') ?? '';
  const body = await response.text();
  if (response.status !== 200) return { path, status: String(response.status), ms, ok: false, detail: 'expected 200' };
  if (!type.startsWith('text/html')) return { path, status: '200', ms, ok: false, detail: 'not an HTML page' };
  return { path, status: '200', ms, ok: true, detail: `HTML, ${Math.round(body.length / 1024)} KB` };
}

async function checkJson<T>(origin: string, path: string, schema: z.ZodType<T>, describe: (value: T) => string): Promise<CheckResult> {
  const { response, ms, failure } = await get(origin, path);
  if (response === null) return { path, status: '-', ms, ok: false, detail: failure };
  const type = response.headers.get('content-type') ?? '';
  const body = await response.text();
  if (response.status !== 200) return { path, status: String(response.status), ms, ok: false, detail: 'expected 200' };
  if (!type.startsWith('application/json')) return { path, status: '200', ms, ok: false, detail: 'not JSON' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { path, status: '200', ms, ok: false, detail: 'the body is not valid JSON' };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    // Paths only, never values: the fields named are public, but the habit keeps output safe to paste.
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.') || '(top level)'))].slice(0, 5);
    return { path, status: '200', ms, ok: false, detail: `unexpected shape at ${fields.join(', ')}` };
  }
  return { path, status: '200', ms, ok: true, detail: describe(result.data) };
}

function printTable(rows: CheckResult[]): void {
  const pathWidth = Math.max(4, ...rows.map((row) => row.path.length));
  console.log(`  ${'path'.padEnd(pathWidth)}  status  ${'ms'.padStart(6)}  result`);
  for (const row of rows) {
    console.log(`  ${row.path.padEnd(pathWidth)}  ${row.status.padEnd(6)}  ${String(row.ms).padStart(6)}  ${row.ok ? 'ok' : 'FAIL'}: ${row.detail}`);
  }
}

async function main(): Promise<void> {
  const origin = originOf(process.argv[2]);
  if (origin === null) {
    console.error('Usage: npm run smoke -w packages/web -- <origin>, for example https://your-site.vercel.app (no path).');
    process.exitCode = 2;
    return;
  }
  console.log(`Ellai smoke test against ${origin}\n`);
  const rows: CheckResult[] = [];
  for (const path of PAGES) rows.push(await checkPage(origin, path));
  rows.push(
    await checkJson(origin, '/api/public/proof', proofSchema, (proof) =>
      [
        `${proof.payments.length} payments and ${proof.memories.length} memories listed`,
        `totals: ${proof.totals.verifiedPayments} verified payments, ${proof.totals.confirmedOwnerAnswers} owner answers on chain, ${proof.totals.approvedByLearning} learned approvals, ${proof.totals.askedDecisions} questions asked`,
      ].join('; '),
    ),
  );
  rows.push(
    await checkJson(origin, '/api/public/memory-map', memoryMapSchema, (map) =>
      [
        `${map.memories.length} memories, ${map.decisions.length} decisions, ${map.decisions.reduce((sum, decision) => sum + decision.citations.length, 0)} citations`,
        `totals: ${map.totals.memories} memories, ${map.totals.learnedApprovals} learned approvals, ${map.totals.questionsAsked} questions asked`,
      ].join('; '),
    ),
  );
  printTable(rows);
  const failed = rows.filter((row) => !row.ok).length;
  if (failed === 0) {
    console.log(`\nPASS: all ${rows.length} checks answered 200 in the expected shape.`);
  } else {
    console.log(`\nFAIL: ${failed} of ${rows.length} checks failed.`);
    process.exitCode = 1;
  }
}

main().catch(() => {
  console.error('\nSTOPPED: the smoke test itself failed before it could report');
  process.exitCode = 1;
});
