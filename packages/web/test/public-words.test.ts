// Covers: the words and colours a public decision wears. "Paid" only with a digest, the cause
// only from the rule, a reason line for every rule the server writes, the landing page's second
// counter counting only learned approvals, the hero picking its example only from approvals
// with a verified payment, a learned one before any other rule, and the seller host /proof and
// the memory map both write, on PGlite: the learning test's stand-in host by name, any host
// outside plain DNS as "this seller", and no host for a memory that names none.
// Does NOT cover: how the components lay these words out, or what the server writes into a
// decision (memory-map.test.ts and decide.test.ts), or which rows the public reads list
// (routes-public.test.ts and memory-map.test.ts).
import { randomBytes } from 'node:crypto';
import { canonicalSuiAddress } from '@ellai/core/keys';
import { USDC_TYPE_MAINNET } from '@ellai/core/usdc';
import { toBase58 } from '@mysten/sui/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, migrate } from '../src/server/db/client.js';
import { agents, decisions, memories, owners, payments } from '../src/server/db/schema.js';
import { readMemoryMap, readPublicProof } from '../src/server/public/proof.js';
import { badgeFor, reasonFor } from '../src/ui/DecisionCard.js';
import { exampleSignature, pickExample } from '../src/ui/decide-model.js';
import type { MapDecision } from '../src/ui/memory-map.js';
import { buildTimeline, tallyThrough, timelineSignature } from '../src/ui/timeline-model.js';

const DIGEST = '4Hq9c2DigestOfAVerifiedPayment';

function decision(change: Partial<MapDecision> = {}): MapDecision {
  return {
    id: 'd1',
    at: '2026-10-01T10:00:00.000Z',
    outcome: 'approved',
    rule: 'learned',
    host: 'hotels.example',
    amountUsdc: '0.100000',
    digest: null,
    citations: [],
    ...change,
  };
}

describe('badgeFor', () => {
  it('says paid only when a digest is set, and takes the cause from the rule', () => {
    expect(badgeFor(decision({ digest: DIGEST }))).toEqual({ label: 'PAID ON ITS OWN', tone: 'border-paid text-paid' });
    expect(badgeFor(decision({ rule: 'grant', digest: DIGEST }))).toEqual({
      label: 'PAID WITH YOUR YES',
      tone: 'border-paid text-paid',
    });
    expect(badgeFor(decision())).toEqual({ label: 'APPROVED ON ITS OWN', tone: 'border-accent text-accent' });
    expect(badgeFor(decision({ rule: 'grant' }))).toEqual({
      label: 'APPROVED WITH YOUR YES',
      tone: 'border-line text-muted',
    });
  });

  it('treats any approval that is not learned as a yes the owner gave', () => {
    expect(badgeFor(decision({ rule: 'something_new' })).label).toBe('APPROVED WITH YOUR YES');
    expect(badgeFor(decision({ rule: 'something_new', digest: DIGEST })).label).toBe('PAID WITH YOUR YES');
  });

  it('keeps asked and refused as they were, whatever the rule or digest', () => {
    expect(badgeFor(decision({ outcome: 'asked', rule: 'no_match' }))).toEqual({
      label: 'ASKED YOU',
      tone: 'border-asked text-asked',
    });
    expect(badgeFor(decision({ outcome: 'refused', rule: 'refused_recipient', digest: DIGEST }))).toEqual({
      label: 'REFUSED',
      tone: 'border-refused text-refused',
    });
  });
});

describe('reasonFor', () => {
  it('words a learned approval by what it matched', () => {
    const citations = [
      { blobId: 'a', distance: 0.31 },
      { blobId: 'b', distance: 0.118 },
      { blobId: 'c', distance: null },
    ];
    expect(reasonFor(decision({ citations }))).toBe('Matched 3 of your past answers by meaning');
    expect(reasonFor(decision({ citations: [{ blobId: 'a', distance: null }] }))).toBe('Matched 1 of your past answers');
    expect(reasonFor(decision())).toBe('Matched your past answers');
  });

  it('says paid for a grant only when a digest is set', () => {
    expect(reasonFor(decision({ rule: 'grant', digest: DIGEST }))).toBe('Paid with the yes you gave');
    expect(reasonFor(decision({ rule: 'grant' }))).toBe('Approved with the yes you gave');
  });

  it('has a line for every rule the server writes, and none for a rule it does not know', () => {
    const lines: Array<[string, string]> = [
      ['refused_recipient', 'You said no to this seller before'],
      ['bad_outcome', 'This seller has not been seen to deliver yet'],
      ['no_match', 'Not enough past answers like this yet'],
      ['recall_unavailable', 'Could not search your past answers, so it asked'],
      ['too_many_pending', 'Too many questions already waiting for you'],
      ['paused', 'Payments are paused'],
      ['over_payment_max', 'Above the most you allow per payment'],
      ['over_daily_budget', 'Over your daily budget'],
    ];
    for (const [rule, line] of lines) {
      expect(reasonFor(decision({ outcome: 'asked', rule }))).toBe(line);
    }
    expect(reasonFor(decision({ rule: 'something_new' }))).toBeNull();
  });
});

describe('the learning counters', () => {
  it('counts questions, and counts only learned approvals, paid or not, not grants', () => {
    const nodes = buildTimeline([
      decision({ id: '5', at: '2026-10-05T10:00:00.000Z', outcome: 'refused', rule: 'refused_recipient' }),
      decision({ id: '4', at: '2026-10-04T10:00:00.000Z', rule: 'grant', digest: DIGEST }),
      decision({ id: '3', at: '2026-10-03T10:00:00.000Z', digest: DIGEST }),
      decision({ id: '2', at: '2026-10-02T10:00:00.000Z' }),
      decision({ id: '1', at: '2026-10-01T10:00:00.000Z', outcome: 'asked', rule: 'no_match' }),
    ]);
    expect(nodes.map((node) => node.id)).toEqual(['1', '2', '3', '4', '5']);
    expect(tallyThrough(nodes, 0)).toEqual({ asked: 0, learned: 0 });
    expect(tallyThrough(nodes, 2)).toEqual({ asked: 1, learned: 1 });
    expect(tallyThrough(nodes, 5)).toEqual({ asked: 1, learned: 2 });
  });

  it('keeps the whole decision on each mark so its badge can be worked out', () => {
    const [node] = buildTimeline([decision({ digest: DIGEST })]);
    expect(node?.decision.digest).toBe(DIGEST);
  });

  it('changes the timeline signature when a decision gains a digest', () => {
    expect(timelineSignature([decision()])).not.toBe(timelineSignature([decision({ digest: DIGEST })]));
  });
});

describe('pickExample', () => {
  const newer = '2026-10-09T10:00:00.000Z';
  const older = '2026-10-02T10:00:00.000Z';

  it('prefers a verified learned approval over everything, newest first', () => {
    const picked = pickExample([
      decision({ id: 'grant-paid', at: newer, rule: 'grant', digest: DIGEST }),
      decision({ id: 'learned-open', at: newer }),
      decision({ id: 'learned-paid-old', at: older, digest: 'old' }),
      decision({ id: 'learned-paid-new', at: '2026-10-05T10:00:00.000Z', digest: 'new' }),
    ]);
    expect(picked?.decision.id).toBe('learned-paid-new');
    expect(picked?.digest).toBe('new');
  });

  it('never picks an unpaid learned approval, even when it is the only approval', () => {
    expect(pickExample([decision({ id: 'learned-open' })])).toBeNull();
    expect(
      pickExample([decision({ id: 'learned-open', at: newer }), decision({ id: 'learned-open-old', at: older })]),
    ).toBeNull();
  });

  it('picks a verified grant over an unpaid learned approval', () => {
    expect(
      pickExample([
        decision({ id: 'learned-open', at: newer }),
        decision({ id: 'grant-paid', at: older, rule: 'grant', digest: DIGEST }),
      ])?.decision.id,
    ).toBe('grant-paid');
  });

  it('picks a verified learned approval over a verified grant, even when the grant is newer', () => {
    expect(
      pickExample([
        decision({ id: 'grant-paid', at: newer, rule: 'grant', digest: DIGEST }),
        decision({ id: 'learned-paid', at: older, digest: 'learned' }),
      ])?.decision.id,
    ).toBe('learned-paid');
  });

  it('takes a verified approval on any other rule when no learned one is verified, newest first', () => {
    const picked = pickExample([
      decision({ id: 'other-old', at: older, rule: 'something_new', digest: 'old' }),
      decision({ id: 'other-new', at: newer, rule: 'something_new', digest: 'new' }),
      decision({ id: 'learned-open', at: newer }),
    ]);
    expect(picked?.decision.id).toBe('other-new');
    expect(picked?.digest).toBe('new');
  });

  it('picks nothing from questions, refusals, unpaid grants and unpaid learned approvals', () => {
    expect(
      pickExample([
        decision({ outcome: 'asked', rule: 'no_match' }),
        decision({ outcome: 'asked', rule: 'no_match', digest: DIGEST }),
        decision({ outcome: 'refused', rule: 'refused_recipient' }),
        decision({ outcome: 'refused', rule: 'refused_recipient', digest: DIGEST }),
        decision({ rule: 'grant' }),
        decision({ rule: 'learned' }),
      ]),
    ).toBeNull();
    expect(pickExample([])).toBeNull();
  });

  it('hands the card the picked decision, so its badge is the paid one for its rule', () => {
    const grant = pickExample([decision({ rule: 'grant', digest: DIGEST })]);
    expect(grant ? badgeFor(grant.decision).label : null).toBe('PAID WITH YOUR YES');
    const learned = pickExample([decision({ digest: DIGEST })]);
    expect(learned ? badgeFor(learned.decision).label : null).toBe('PAID ON ITS OWN');
  });

  it('changes the example signature when the rule or the digest changes, and says none for no example', () => {
    const base = exampleSignature(pickExample([decision({ digest: DIGEST })]));
    expect(exampleSignature(pickExample([decision({ digest: 'another' })]))).not.toBe(base);
    expect(exampleSignature(pickExample([decision({ rule: 'grant', digest: DIGEST })]))).not.toBe(base);
    expect(exampleSignature(pickExample([decision()]))).toBe('none');
  });
});

describe('the seller host on both public reads', () => {
  const STAND_IN = 'Ellai wallet check (learning test)';
  const RECIPIENT = canonicalSuiAddress(`0x${'11'.repeat(32)}`);
  const hex = (bytes: number) => randomBytes(bytes).toString('hex');
  const now = new Date('2031-01-01T10:00:00.000Z');
  const at = (msAgo: number) => new Date(now.getTime() - msAgo);
  let handle: Awaited<ReturnType<typeof createDb>>;

  beforeAll(async () => {
    handle = await createDb('pglite:memory');
    await migrate(handle.db);
  });

  afterAll(async () => {
    await handle.close();
  });

  it('names the learning test stand-in on /proof and the map, writes a host outside plain DNS as this seller, and none for a memory that names none', async () => {
    const purseAddress = canonicalSuiAddress(`0x${hex(32)}`);
    const [owner] = await handle.db
      .insert(owners)
      .values({ suiAddress: canonicalSuiAddress(`0x${hex(32)}`), purseAddress, publicProof: true })
      .returning({ id: owners.id });
    const ownerId = owner?.id ?? '';
    const [agent] = await handle.db
      .insert(agents)
      .values({ ownerId, label: 'Learning test agent', kind: 'external', tokenHash: hex(32), tokenPrefix: 'ellai_agent_' })
      .returning({ id: agents.id });

    const stored = (blobId: string, kind: 'owner_decision' | 'outcome', sellerHost: string | null, msAgo: number) =>
      handle.db.insert(memories).values({
        ownerId,
        kind,
        recipient: RECIPIENT,
        amountAtomic: 10_000n,
        verdict: kind === 'owner_decision' ? 'approve' : null,
        sellerHost,
        sentence: 'The owner said yes.',
        namespace: 'ellai-v1',
        writerPublicKey: hex(32),
        blobId,
        status: 'confirmed',
        confirmedAt: at(msAgo),
        chainConfirmedAt: at(msAgo),
      });
    const paid = async (sellerHost: string, msAgo: number) => {
      const [row] = await handle.db
        .insert(decisions)
        .values({
          ownerId,
          agentId: agent?.id ?? '',
          requestKey: hex(16),
          sellerUrl: `https://${sellerHost}/api/sell/wallet-check`,
          sellerMethod: 'POST',
          sellerHost,
          bodyHash: hex(32),
          purpose: 'Check a wallet',
          recipient: RECIPIENT,
          amountAtomic: 10_000n,
          asset: USDC_TYPE_MAINNET,
          network: 'sui:mainnet',
          expiresAt: at(-60_000),
          outcome: 'approved',
          rule: 'grant',
          reason: 'You said yes.',
          status: 'paid',
          createdAt: at(msAgo),
        })
        .returning({ id: decisions.id });
      await handle.db.insert(payments).values({
        decisionId: row?.id ?? '',
        ownerId,
        purseAddress,
        recipient: RECIPIENT,
        amountAtomic: 10_000n,
        digest: toBase58(randomBytes(32)),
        txBytesBase64: 'AA==',
        signedAt: at(msAgo),
        validUntilEpoch: 1n,
        settlement: 'verified',
      });
    };

    await stored('stand-in-answer', 'owner_decision', 'ellai.invalid', 300_000);
    await stored('odd-host-answer', 'owner_decision', 'evil"host.example', 200_000);
    await stored('no-host-outcome', 'outcome', null, 100_000);
    await paid('ellai.invalid', 60_000);
    await paid('evil"host.example', 30_000);

    const proof = await readPublicProof(handle.db);
    expect(proof.memories.map((row) => [row.blobId, row.host])).toEqual([
      ['no-host-outcome', null],
      ['odd-host-answer', 'this seller'],
      ['stand-in-answer', STAND_IN],
    ]);
    expect(proof.payments.map((row) => row.sellerHost)).toEqual(['this seller', STAND_IN]);

    const map = await readMemoryMap(handle.db, now);
    expect(map.memories.map((row) => [row.blobId, row.host])).toEqual([
      ['odd-host-answer', 'this seller'],
      ['stand-in-answer', STAND_IN],
    ]);
    expect(map.decisions.map((row) => row.host)).toEqual(['this seller', STAND_IN]);
  });
});
