// Covers: tatumMeter as a real core chain's beforeRequest hook, on PGlite, with stand-in GraphQL
// answers counting what is actually sent and the seven day budgets cut small (LIMITS is mocked,
// each to its own size) so each is reached in a few requests: a request outside any scope refused
// with nothing sent; one client's day, one owner's day, the day every caller with no owner shares
// and the day every person shares each refusing at exactly its own limit with no request sent past
// it and nothing counted after the first refusal, so strangers spending theirs leave owners able to
// sign; the jobs budget kept apart, whole after persons spend the shared day and spending none of
// it, and one owner's jobs share spent leaving the jobs day for every other owner; the refills pool
// kept apart from the jobs day and every owner's jobs share, both ways; each shared budget logged
// once a day; and a new UTC day starting over.
// Does NOT cover: real Tatum or gRPC (core's chain.test.ts runs the hook on a stand-in gRPC
// transport), several server instances counting at once (they share the one database, and PGlite
// serves one connection), or which route enters which scope (routes-scope.test.ts).
import { randomUUID } from 'node:crypto';
import { type Chain, ChainError, createChain } from '@ellai/core/chain';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Database, createDb, migrate } from '../src/server/db/client.js';
import { type TatumScope, tatumMeter, withTatumScope } from '../src/server/http/tatum-meter.js';

// The shared day is larger than one client's and one owner's days together, so a test can show
// that a request refused by one of those never reached the counts after it. The anonymous day sits
// inside the persons' day, and one owner's jobs share inside the jobs day, as in LIMITS.
const { CLIENT_DAY, OWNER_DAY, ANONYMOUS_DAY, PERSONS_DAY, JOBS_DAY, JOBS_OWNER_DAY, REFILLS_DAY } = vi.hoisted(() => ({
  CLIENT_DAY: 4,
  OWNER_DAY: 3,
  ANONYMOUS_DAY: 5,
  PERSONS_DAY: 8,
  JOBS_DAY: 5,
  JOBS_OWNER_DAY: 2,
  REFILLS_DAY: 3,
}));

vi.mock('@ellai/core/limits', async (importOriginal) => {
  const real = await importOriginal<typeof import('@ellai/core/limits')>();
  return {
    LIMITS: {
      ...real.LIMITS,
      tatumCallsPerClientPerDay: CLIENT_DAY,
      tatumCallsPerOwnerPerDay: OWNER_DAY,
      tatumCallsAnonymousPerDay: ANONYMOUS_DAY,
      tatumCallsPerDayGlobal: PERSONS_DAY,
      tatumCallsJobsPerDay: JOBS_DAY,
      tatumCallsJobsPerOwnerPerDay: JOBS_OWNER_DAY,
      tatumCallsRefillsPerDay: REFILLS_DAY,
    },
  };
});

const DAY_MS = 86_400_000;
const HOLDER = `0x${'4c'.repeat(32)}`;
const EMPTY_PAGE = JSON.stringify({ data: { address: { objects: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });

let handle: Awaited<ReturnType<typeof createDb>>;
let db: Database;
let chain: Chain;
let clock = new Date('2026-10-26T12:00:00Z');
let sent = 0;
let logs: string[] = [];

beforeAll(async () => {
  handle = await createDb('pglite:memory');
  db = handle.db;
  await migrate(db);
  chain = createChain({ beforeRequest: tatumMeter(db, () => clock) });
});

afterAll(async () => {
  chain.close();
  await handle.close();
});

beforeEach(() => {
  // Each test counts in a UTC day of its own.
  clock = new Date(clock.getTime() + DAY_MS);
  sent = 0;
  logs = [];
  vi.stubGlobal('fetch', async () => {
    sent += 1;
    return new Response(EMPTY_PAGE, { status: 200, headers: { 'content-type': 'application/json' } });
  });
  for (const level of ['warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** One request to Tatum, a single GraphQL page, inside `scope` (or none): 'sent', or the ChainError code it failed with. */
async function request(scope: TatumScope | null): Promise<string> {
  const run = () => chain.listOwnedWalrusBlobs(HOLDER);
  try {
    await (scope === null ? run() : withTatumScope(scope, run));
    return 'sent';
  } catch (error) {
    if (error instanceof ChainError) return error.code;
    throw error;
  }
}

const person = (clientKey: string, ownerId?: string): TatumScope => (ownerId === undefined ? { kind: 'person', clientKey } : { kind: 'person', clientKey, ownerId });
const JOBS: TatumScope = { kind: 'jobs' };
const jobsFor = (ownerId: string): TatumScope => ({ kind: 'jobs', ownerId });
const REFILLS: TatumScope = { kind: 'refills' };
const repeat = <T>(n: number, value: T): T[] => Array<T>(n).fill(value);
const fresh = (label: string) => `${label}-${randomUUID()}`;
/** A signed-in owner on a client of its own, so only the persons' day is shared with anyone. */
const someOwner = (): TatumScope => person(fresh('client'), randomUUID());

async function requests(scopes: TatumScope[]): Promise<string[]> {
  const outcomes: string[] = [];
  for (const scope of scopes) outcomes.push(await request(scope));
  return outcomes;
}

describe('tatumMeter', () => {
  it('refuses a request made outside any scope, sending nothing', async () => {
    expect(await request(null)).toBe('BUDGET');
    expect(sent).toBe(0);
    expect(logs).toEqual(['[ellai tatum] no_scope']);
  });

  it('holds one client to its day across every owner it acts for, and a refused request counts toward nothing after the limit that refused it', async () => {
    const client = fresh('client');
    const owners = Array.from({ length: CLIENT_DAY + 1 }, () => randomUUID());
    expect(await requests(owners.map((ownerId) => person(client, ownerId)))).toEqual([...Array<string>(CLIENT_DAY).fill('sent'), 'BUDGET']);
    expect(sent).toBe(CLIENT_DAY);

    // The owner of the refused request still has its whole day, so that request never reached it.
    const refusedOwner = owners[CLIENT_DAY] ?? '';
    expect(await requests(Array.from({ length: OWNER_DAY + 1 }, () => person(fresh('client'), refusedOwner)))).toEqual([...Array<string>(OWNER_DAY).fill('sent'), 'BUDGET']);
    // The shared day holds exactly the requests sent, so neither refusal reached it either.
    const left = PERSONS_DAY - CLIENT_DAY - OWNER_DAY;
    expect(await requests(Array.from({ length: left + 1 }, () => person(fresh('client'))))).toEqual([...Array<string>(left).fill('sent'), 'BUDGET']);
    expect(sent).toBe(PERSONS_DAY);
    expect(logs).toEqual(['[ellai tatum] client rate_limited_today', '[ellai tatum] owner rate_limited_today', '[ellai tatum] quota_spent tatum-calls:day']);
  });

  it('holds one owner to its day across every client it is reached from', async () => {
    const ownerId = randomUUID();
    expect(await requests(Array.from({ length: OWNER_DAY + 1 }, () => person(fresh('client'), ownerId)))).toEqual([...Array<string>(OWNER_DAY).fill('sent'), 'BUDGET']);
    expect(sent).toBe(OWNER_DAY);
    expect(logs).toEqual(['[ellai tatum] owner rate_limited_today']);
    // The same owner spelled in capitals is the same count.
    expect(await request(person(fresh('client'), ownerId.toUpperCase()))).toBe('BUDGET');
    expect(sent).toBe(OWNER_DAY);
  });

  it('stops every person once the shared day is spent, logs that once, and starts over the next UTC day', async () => {
    const owners = Array.from({ length: PERSONS_DAY + 2 }, someOwner);
    expect(await requests(owners)).toEqual([...Array<string>(PERSONS_DAY).fill('sent'), 'BUDGET', 'BUDGET']);
    expect(sent).toBe(PERSONS_DAY);
    expect(logs).toEqual(['[ellai tatum] quota_spent tatum-calls:day']);
    // A stranger is refused as well.
    expect(await request(person(fresh('client')))).toBe('BUDGET');

    clock = new Date(clock.getTime() + DAY_MS);
    expect(await request(person(fresh('client')))).toBe('sent');
    expect(sent).toBe(PERSONS_DAY + 1);
  });

  it('holds every caller with no owner to the anonymous day inside the shared one, so strangers using theirs up leave owners able to sign (C22)', async () => {
    expect(ANONYMOUS_DAY).toBeLessThan(PERSONS_DAY);
    const strangers = Array.from({ length: ANONYMOUS_DAY + 2 }, () => person(fresh('client')));
    expect(await requests(strangers)).toEqual([...Array<string>(ANONYMOUS_DAY).fill('sent'), 'BUDGET', 'BUDGET']);
    expect(logs).toEqual(['[ellai tatum] quota_spent tatum-anonymous-calls:day']);
    // The refused strangers never reached the shared day: owners have exactly what is left of it.
    const left = PERSONS_DAY - ANONYMOUS_DAY;
    expect(await requests(Array.from({ length: left + 1 }, someOwner))).toEqual([...Array<string>(left).fill('sent'), 'BUDGET']);
    expect(sent).toBe(PERSONS_DAY);
  });

  it('keeps the jobs budget apart: persons spending the shared day leave it whole, and the jobs spend none of theirs', async () => {
    expect(await requests(Array.from({ length: PERSONS_DAY + 1 }, someOwner))).toEqual([...Array<string>(PERSONS_DAY).fill('sent'), 'BUDGET']);
    expect(await requests(Array.from({ length: JOBS_DAY + 1 }, () => JOBS))).toEqual([...Array<string>(JOBS_DAY).fill('sent'), 'BUDGET']);
    expect(sent).toBe(PERSONS_DAY + JOBS_DAY);
    expect(logs).toEqual(['[ellai tatum] quota_spent tatum-calls:day', '[ellai tatum] quota_spent tatum-jobs-calls:day']);

    clock = new Date(clock.getTime() + DAY_MS);
    sent = 0;
    expect(await requests(Array.from({ length: JOBS_DAY }, () => JOBS))).toEqual(Array<string>(JOBS_DAY).fill('sent'));
    expect(await requests(Array.from({ length: PERSONS_DAY }, someOwner))).toEqual(Array<string>(PERSONS_DAY).fill('sent'));
    expect(sent).toBe(JOBS_DAY + PERSONS_DAY);
  });

  it("holds the tick's visits to one owner to that owner's jobs share, so one owner using it up leaves the jobs day for every other (C22, C28)", async () => {
    const greedy = randomUUID();
    expect(await requests(Array.from({ length: JOBS_OWNER_DAY + 2 }, () => jobsFor(greedy)))).toEqual([...Array<string>(JOBS_OWNER_DAY).fill('sent'), 'BUDGET', 'BUDGET']);
    expect(logs).toEqual(Array<string>(2).fill('[ellai tatum] jobs_owner rate_limited_today'));
    // The same owner spelled in capitals is the same share.
    expect(await request(jobsFor(greedy.toUpperCase()))).toBe('BUDGET');
    // None of the refusals reached the jobs day: the rest of it is still there for the others.
    const other = randomUUID();
    expect(await requests([jobsFor(other), jobsFor(other), JOBS])).toEqual(['sent', 'sent', 'sent']);
    expect(sent).toBe(JOBS_DAY);
    expect(await request(jobsFor(randomUUID()))).toBe('BUDGET');
    expect(logs.at(-1)).toBe('[ellai tatum] quota_spent tatum-jobs-calls:day');
  });

  it("keeps refills in a pool of their own: the jobs day and every owner's jobs share spent leave it whole, and refills spend none of them (C23, C28)", async () => {
    const owners = [randomUUID(), randomUUID()];
    // Payment reads as the tick makes them: each owner past its share, and the jobs day spent between them.
    for (const ownerId of owners) await requests(repeat(JOBS_OWNER_DAY + 1, jobsFor(ownerId)));
    expect(await requests([JOBS, jobsFor(randomUUID())])).toEqual(['sent', 'BUDGET']);
    expect(sent).toBe(JOBS_DAY);

    expect(await requests(repeat(REFILLS_DAY + 1, REFILLS))).toEqual([...repeat(REFILLS_DAY, 'sent'), 'BUDGET']);
    expect(sent).toBe(JOBS_DAY + REFILLS_DAY);
    expect(logs.filter((line) => line.includes('quota_spent'))).toEqual(['[ellai tatum] quota_spent tatum-jobs-calls:day', '[ellai tatum] quota_spent tatum-refills-calls:day']);

    // The next day, refills spending their whole pool leave the jobs day and an owner's share whole.
    clock = new Date(clock.getTime() + DAY_MS);
    sent = 0;
    expect(await requests(repeat(REFILLS_DAY, REFILLS))).toEqual(repeat(REFILLS_DAY, 'sent'));
    expect(await requests([...repeat(JOBS_OWNER_DAY, jobsFor(owners[0] ?? '')), ...repeat(JOBS_DAY - JOBS_OWNER_DAY, JOBS)])).toEqual(repeat(JOBS_DAY, 'sent'));
    expect(sent).toBe(REFILLS_DAY + JOBS_DAY);
  });
});
