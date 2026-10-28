'use client';

import { useCurrentAccount, useSignPersonalMessage } from '@mysten/dapp-kit';
import { useEffect, useRef, useState } from 'react';
import {
  isApiError,
  requestStepUp,
  type ApiError,
  type StepUpIssued,
  type StepUpProof,
  type StepUpRequest,
} from './api.js';
import { Modal } from './Modal.js';
import { Button, ErrorLine, Ring } from './ui.js';
import { DECLINED, NOT_CONNECTED } from './wallet-messages.js';

type Phase = 'requesting' | 'ready' | 'waiting' | 'sending' | 'failed';

const REJECTED = "Your wallet's signature was not accepted. Start again.";
const PAUSE_CHANGED = 'The pause changed since you asked. Review it and start again.';

function failureText(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === 'step_up_rejected') return REJECTED;
    if (error.code === 'pause_changed') return PAUSE_CHANGED;
    return error.message;
  }
  return 'Something went wrong. Try again.';
}

type Props = {
  /** The exact change that will be sent next. The server signs its wording into the message. */
  request: StepUpRequest;
  /** Sends the change with the proof. It resolves when the change is applied or has failed in a way the screen shows itself. */
  send: (proof: StepUpProof) => Promise<void>;
  onDone: () => void;
  onCancel: () => void;
  /** Errors the screen shows under its own field. Return true to take one: the dialog then closes. */
  handoff?: (error: ApiError) => boolean;
};

/**
 * Asks the wallet to confirm one loosening change. A stolen login cannot make the change, because
 * the signature has to come from the owner's wallet. A step-up works once, so every failure ends
 * in a fresh request, never a retry of the old message.
 */
export function StepUpDialog({ request, send, onDone, onCancel, handoff }: Props) {
  const account = useCurrentAccount();
  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();
  const [phase, setPhase] = useState<Phase>('requesting');
  const [issued, setIssued] = useState<StepUpIssued | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Each attempt gets a number, so a wallet or network answer that arrives after the person
  // pressed Cancel or Start again is thrown away instead of acted on.
  const attempt = useRef(0);
  const alive = useRef(true);
  const started = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  function stale(mine: number): boolean {
    return attempt.current !== mine || !alive.current;
  }

  function fail(caught: unknown) {
    if (isApiError(caught) && handoff?.(caught)) {
      onCancel();
      return;
    }
    setError(failureText(caught));
    setPhase('failed');
  }

  async function begin() {
    const mine = ++attempt.current;
    setPhase('requesting');
    setIssued(null);
    setError(null);
    try {
      const next = await requestStepUp(request);
      if (stale(mine)) return;
      setIssued(next);
      setPhase('ready');
    } catch (caught) {
      if (stale(mine)) return;
      fail(caught);
    }
  }

  useEffect(() => {
    // Strict mode runs effects twice in development; a second request would waste one of the hour's ten.
    if (started.current) return;
    started.current = true;
    void begin();
  }, []);

  async function sign() {
    if (issued === null) return;
    if (!account) {
      setError(NOT_CONNECTED);
      setPhase('failed');
      return;
    }
    const mine = ++attempt.current;
    setError(null);
    setPhase('waiting');
    let signature: string;
    try {
      ({ signature } = await signPersonalMessage({ message: new TextEncoder().encode(issued.message) }));
    } catch {
      if (stale(mine)) return;
      setError(DECLINED);
      setPhase('failed');
      return;
    }
    if (stale(mine)) return;
    setPhase('sending');
    try {
      await send({ nonce: issued.nonce, signature });
      if (stale(mine)) return;
      onDone();
    } catch (caught) {
      if (stale(mine)) return;
      fail(caught);
    }
  }

  function cancel() {
    if (phase === 'sending') return;
    attempt.current += 1;
    onCancel();
  }

  const working = phase === 'waiting' || phase === 'sending';
  return (
    <Modal title="Confirm in your wallet" onEscape={cancel}>
      <p className="mt-3 text-[15px] leading-[1.5] text-muted">
        This change needs your wallet&apos;s signature, so a stolen login cannot make it.
      </p>

      {phase === 'requesting' || issued !== null ? (
        <div className="mt-6">
          <p className="label-mono text-muted">YOUR WALLET WILL SHOW THIS</p>
          {issued === null ? (
            <div role="status" aria-label="Asking for the message" className="mt-2 grid h-24 place-items-center text-accent">
              <div className="h-8 w-8">
                <Ring stroke={2} className="ring-spin" />
              </div>
            </div>
          ) : (
            <div className="mt-2 max-h-[240px] overflow-y-auto whitespace-pre-wrap rounded-button border border-line bg-bg p-3 font-mono text-[13px] leading-[1.5] text-fg [overflow-wrap:anywhere]">
              {issued.message}
            </div>
          )}
        </div>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          size="lg"
          className="min-w-[160px] flex-1"
          disabled={phase !== 'ready'}
          busy={working}
          onClick={() => void sign()}
        >
          {phase === 'waiting' ? 'Waiting for your wallet...' : 'Sign with wallet'}
        </Button>
        <Button size="lg" disabled={phase === 'sending'} onClick={cancel}>
          Cancel
        </Button>
      </div>

      {error ? (
        <div className="mt-4 flex flex-col items-start gap-2">
          <ErrorLine>{error}</ErrorLine>
          <Button variant="text" onClick={() => void begin()}>
            Start again
          </Button>
        </div>
      ) : null}
    </Modal>
  );
}
