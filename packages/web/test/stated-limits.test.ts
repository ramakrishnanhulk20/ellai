// Covers: each limit the public copy states in numbers holds the value the code enforces: the
// purse float in WalletSection (0.20 USDC), the recall wait and the SDK call ceiling in WalrusFinding (15 and 120 seconds), the
// length of the /proof lists in ProofBoard (20 newest), and the number of yeses in the journey
// beat (two, the default every new owner gets). A limit changed in core or the schema fails here
// until the copy is changed to match.
// Does NOT cover: copy in the docs and the README, numbers that are not a limit, or whether the
// sentence around a number is still true.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LIMITS } from '@ellai/core/limits';
import { describe, expect, it } from 'vitest';
import { owners } from '../src/server/db/schema.js';
import { BEATS } from '../src/ui/site/journey-model.js';

function siteSource(name: string): string {
  const path = fileURLToPath(new URL(`../src/ui/site/${name}`, import.meta.url));
  return readFileSync(path, 'utf8').replace(/\s+/g, ' ');
}

const USDC_DECIMALS = 1_000_000;
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

describe('limits stated in the public copy', () => {
  it('WalletSection states the purse float, LIMITS.purseMaxFloatAtomic, every time it names an amount', () => {
    const float = (LIMITS.purseMaxFloatAtomic / USDC_DECIMALS).toFixed(2);
    const text = siteSource('WalletSection.tsx');
    expect(text).toContain(`holds at most ${float} USDC`);
    expect(text).toContain(`At most ${float} USDC sits ready to pay`);
    expect(text).toContain(`${float}{' '} <span`);
    const named = [...text.matchAll(/(\d+\.\d{2})(?=\{' '\}| USDC)/g)].map((match) => match[1]);
    expect(named.length).toBeGreaterThanOrEqual(3);
    expect(new Set(named)).toEqual(new Set([float]));
  });

  it('WalrusFinding states the recall wait, LIMITS.decideRecallTimeoutMs, in seconds', () => {
    const seconds = LIMITS.decideRecallTimeoutMs / 1000;
    expect(siteSource('WalrusFinding.tsx')).toContain(`waits at most ${seconds} seconds for a memory search`);
  });

  it('WalrusFinding states the ceiling on every SDK call, LIMITS.memwalCallTimeoutMs, in seconds', () => {
    const seconds = LIMITS.memwalCallTimeoutMs / 1000;
    expect(siteSource('WalrusFinding.tsx')).toContain(`inside the ${seconds}-second ceiling on every SDK call`);
  });

  it('ProofBoard states how many rows each list shows, LIMITS.publicProofLatest', () => {
    expect(siteSource('ProofBoard.tsx')).toContain(`up to the ${LIMITS.publicProofLatest} newest of each`);
  });

  it('the journey beat states the yeses a new owner needs, the default of owners.approvalsNeeded', () => {
    const needed = owners.approvalsNeeded.default;
    expect(typeof needed).toBe('number');
    const word = NUMBER_WORDS[needed as number];
    expect(word).toBeDefined();
    const beat = BEATS.find((entry) => entry.id === 'settled');
    expect(beat?.text).toContain(`With ${word} of your yeses`);
    expect(needed).toBeGreaterThanOrEqual(LIMITS.approvalsNeededMin);
    expect(needed).toBeLessThanOrEqual(LIMITS.approvalsNeededMax);
  });
});
