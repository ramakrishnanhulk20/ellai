import { pickExample, type Example } from '../decide-model.js';
import { formatUsdc } from '../format-usdc.js';
import type { MapDecision, MapMemory, MemoryMap } from '../memory-map.js';

export type BeatId = 'paywall' | 'checks' | 'recall' | 'settled' | 'loop';

export const BEATS: readonly { id: BeatId; title: string; text: string }[] = [
  {
    id: 'paywall',
    title: 'Your agent hits a paywall.',
    text: 'It asks a web seller for something. The seller answers 402: pay first.',
  },
  {
    id: 'checks',
    title: 'Ellai checks your rules first.',
    text: 'Fixed rules, in a fixed order: your limits first, then any refusal you gave. No AI model touches your money.',
  },
  {
    id: 'recall',
    title: 'It looks for your past answers.',
    text: 'Ellai searches your own Walrus Memory for answers like this one, matched by meaning.',
  },
  {
    id: 'settled',
    title: 'Enough yeses, and it pays on its own.',
    text: 'With two of your yeses for this seller at this price or higher, the purse pays on its own. Tatum reads the payment back from Sui.',
  },
  {
    id: 'loop',
    title: 'Anything new, it asks you.',
    text: 'Your yes or no is written to your Walrus Memory. The next time a request like it comes in, Ellai already knows.',
  },
];

/** x is the node's place along the route, 0 at the left end and 1 at the right end. */
export const NODES: readonly { id: 'agent' | 'seller' | 'ellai' | 'walrus' | 'sui'; label: string; x: number }[] = [
  { id: 'agent', label: 'Your agent', x: 0 },
  { id: 'seller', label: 'Seller', x: 0.25 },
  { id: 'ellai', label: 'Ellai', x: 0.5 },
  { id: 'walrus', label: 'Walrus Memory', x: 0.75 },
  { id: 'sui', label: 'Sui Mainnet', x: 1 },
];

/** Where the owner sits on the route: halfway between Ellai and Walrus Memory, above the line. */
export const YOU_X = 0.625;

export type CitedMemory = {
  blobId: string;
  verdict: 'approve' | 'refuse' | null;
  host: string | null;
  amount: string | null;
  at: string | null;
};

export type AskedExample = { amount: string; host: string; at: string };

/** The memory the loop card shows. forAsked is true when it is a memory about the seller of the question shown beside it. */
export type JourneyAnswer = { memory: MapMemory; forAsked: boolean };

export type Journey = {
  example: Example | null;
  cited: CitedMemory[];
  asked: AskedExample | null;
  answer: JourneyAnswer | null;
};

/** The label the public map writes for the learning test's stand-in seller (server/public/proof.ts). It is a test, so a real seller's question is shown ahead of it. */
export const STAND_IN_HOST = 'Ellai wallet check (learning test)';

const MAX_CITED = 3;
const BEAT_COUNT = BEATS.length;
const TRAVEL_SHARE = 0.4;
const LOOP_SHARE = 0.6;

const DAY_FORMAT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** An unreadable time sorts last, so one bad row can never hide a good one. */
function timeOf(iso: string): number {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

/** Strictly later wins, so on a tie the first one in the list stays. */
function newestDecision(decisions: readonly MapDecision[]): MapDecision | null {
  let newest: MapDecision | null = null;
  for (const decision of decisions) {
    if (newest === null || timeOf(decision.at) > timeOf(newest.at)) newest = decision;
  }
  return newest;
}

/**
 * The answer for the seller of the question on the card: the first memory about that seller written at or
 * after the question. The public map spans every opted-in owner, so it is the seller's answer, not one
 * person's reply to their own question. With no such memory, or no question, the newest memory stands in.
 */
function pickAnswer(memories: readonly MapMemory[], asked: AskedExample | null): JourneyAnswer | null {
  if (asked) {
    let earliest: MapMemory | null = null;
    for (const memory of memories) {
      if (memory.host !== asked.host || timeOf(memory.at) < timeOf(asked.at)) continue;
      if (earliest === null || timeOf(memory.at) < timeOf(earliest.at)) earliest = memory;
    }
    if (earliest) return { memory: earliest, forAsked: true };
  }
  let newest: MapMemory | null = null;
  for (const memory of memories) {
    if (newest === null || timeOf(memory.at) > timeOf(newest.at)) newest = memory;
  }
  return newest ? { memory: newest, forAsked: false } : null;
}

/** Everything the five cards say, taken from the public memory map. Nothing here is made up. */
export function buildJourney(map: MemoryMap | null): Journey {
  if (!map) return { example: null, cited: [], asked: null, answer: null };

  const example = pickExample(map.decisions);

  const cited: CitedMemory[] = (example?.decision.citations ?? []).slice(0, MAX_CITED).map((citation) => {
    const memory = map.memories.find((entry) => entry.blobId === citation.blobId);
    if (!memory) return { blobId: citation.blobId, verdict: null, host: null, amount: null, at: null };
    return {
      blobId: citation.blobId,
      verdict: memory.verdict,
      host: memory.host,
      amount: formatUsdc(memory.amountUsdc),
      at: memory.at,
    };
  });

  const questions = map.decisions.filter((entry) => entry.outcome === 'asked');
  const newestAsked =
    newestDecision(questions.filter((entry) => entry.host !== STAND_IN_HOST)) ?? newestDecision(questions);
  const asked: AskedExample | null = newestAsked
    ? { amount: formatUsdc(newestAsked.amountUsdc), host: newestAsked.host, at: newestAsked.at }
    : null;

  return { example, cited, asked, answer: pickAnswer(map.memories, asked) };
}

/** Which of the five beats the scroll is in. The last beat owns the very end of the scroll. */
export function beatAt(progress: number): number {
  return Math.min(BEAT_COUNT - 1, Math.floor(clamp(progress, 0, 1) * BEAT_COUNT));
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** How far into its own beat the scroll is, 0 at the start of the beat and just under 1 at its end. */
function localProgress(progress: number, beat: number): number {
  return clamp(progress, 0, 1) * BEAT_COUNT - beat;
}

/**
 * Where the payment chip sits along the route. In each of the first four beats it travels to the
 * next node during the first 40 percent of the beat, then rests there while the card is read.
 */
export function tokenX(progress: number): number {
  const beat = beatAt(progress);
  const from = NODES[beat];
  const to = NODES[beat + 1];
  if (!from || !to) return 1;
  const travelled = clamp(localProgress(progress, beat) / TRAVEL_SHARE, 0, 1);
  return from.x + (to.x - from.x) * easeInOutCubic(travelled);
}

/** The arc from Ellai up through the owner and down to Walrus Memory draws in the first 60 percent of the last beat. */
export function loopProgress(progress: number): number {
  const beat = beatAt(progress);
  if (beat < BEAT_COUNT - 1) return 0;
  return clamp(localProgress(progress, beat) / LOOP_SHARE, 0, 1);
}

/** "27 Oct". Fixed to UTC and en-GB so the server HTML and the browser agree whatever the viewer's zone. */
export function formatDay(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : DAY_FORMAT.format(date);
}
