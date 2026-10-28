'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { createAgent, fetchAgents, isApiError, revokeAgent, type Agent, type ApiError } from './api.js';
import { TextField } from './controls.js';
import { KeyDialog } from './KeyDialog.js';
import { APP_KEY } from './session.js';
import { StepUpDialog } from './StepUpDialog.js';
import { Button, Card, ErrorLine, PageShell, Skeleton, When } from './ui.js';

const AGENTS_KEY = [APP_KEY, 'agents'] as const;
const LABEL_MAX = 60;
const CONFIRM_WINDOW_MS = 6_000;

// Errors the add card shows under its own field instead of inside the wallet dialog.
const FIELD_ERRORS = new Set(['bad_input', 'too_many_agents', 'too_many_agent_creates']);

function normalise(label: string): string {
  return label.trim().replace(/ {2,}/g, ' ');
}

function AddAgent({ onCreated }: { onCreated: (token: string) => void }) {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState('');
  const [asking, setAsking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clean = normalise(label);

  async function send(proof: { nonce: string; signature: string }) {
    if (asking === null) return;
    const created = await createAgent(asking, proof);
    setLabel('');
    onCreated(created.token);
    await queryClient.refetchQueries({ queryKey: AGENTS_KEY });
  }

  function handoff(caught: ApiError): boolean {
    if (!FIELD_ERRORS.has(caught.code)) return false;
    setError(caught.message);
    return true;
  }

  return (
    <Card className="max-w-[720px]">
      <h2 className="text-[18px] font-medium leading-[1.4] text-fg">Add an agent</h2>
      <form
        className="mt-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (clean === '') return;
          setError(null);
          setAsking(clean);
        }}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <TextField
            className="flex-1"
            label="AGENT NAME"
            placeholder="For example, Trip planner"
            maxLength={LABEL_MAX}
            autoComplete="off"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
          <Button
            type="submit"
            variant="primary"
            size="lg"
            className="min-w-[140px] sm:mt-[26px]"
            disabled={clean === ''}
          >
            Create key
          </Button>
        </div>
        <div className="mt-2 flex items-start justify-between gap-4">
          <div className="min-w-0">{error ? <ErrorLine>{error}</ErrorLine> : null}</div>
          <p className="shrink-0 font-mono text-[12px] text-faint">
            {label.length}/{LABEL_MAX}
          </p>
        </div>
      </form>
      {asking !== null ? (
        <StepUpDialog
          request={{ action: 'create_agent', change: { label: asking } }}
          send={send}
          handoff={handoff}
          onDone={() => setAsking(null)}
          onCancel={() => setAsking(null)}
        />
      ) : null}
    </Card>
  );
}

function StatusCell({ agent }: { agent: Agent }) {
  if (agent.revokedAt !== null) {
    return (
      <span className="text-[14px] leading-[1.4] text-muted">
        Revoked <When iso={agent.revokedAt} />
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 text-[14px] leading-[1.4] text-fg">
      <span aria-hidden="true" className="h-2 w-2 rounded-full bg-accent" />
      Active
    </span>
  );
}

function RevokeControl({ agentId, onRevoked }: { agentId: string; onRevoked: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  function stopConfirming() {
    clearTimeout(timer.current);
    setConfirming(false);
  }

  // Revoking stops the key at once and cannot be undone, so the first press only asks again.
  async function press() {
    if (!confirming) {
      setConfirming(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setConfirming(false), CONFIRM_WINDOW_MS);
      return;
    }
    stopConfirming();
    setError(null);
    setBusy(true);
    try {
      await revokeAgent(agentId);
      await onRevoked();
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-3">
        <Button variant="danger" busy={busy} onClick={() => void press()}>
          {confirming ? 'Revoke for good?' : 'Revoke'}
        </Button>
        {confirming && !busy ? (
          <Button variant="text" onClick={stopConfirming}>
            Cancel
          </Button>
        ) : null}
      </div>
      {error ? <ErrorLine>{error}</ErrorLine> : null}
    </div>
  );
}

function AgentRow({ agent, onRevoked }: { agent: Agent; onRevoked: () => Promise<void> }) {
  const revoked = agent.revokedAt !== null;
  const external = agent.kind === 'external';
  return (
    <li
      className={`border-line max-xl:rounded-card max-xl:border max-xl:bg-panel max-xl:p-4 xl:border-b xl:py-0 ${
        revoked ? 'opacity-50' : ''
      }`}
    >
      <div className="flex flex-col gap-3 xl:min-h-16 xl:grid xl:grid-cols-[minmax(0,1fr)_80px_130px_120px_340px] xl:items-center xl:gap-x-4 xl:gap-y-0">
        <div className="flex items-baseline justify-between gap-3 xl:contents">
          <span className="min-w-0 text-[15px] leading-[1.4] text-fg [overflow-wrap:anywhere]" title={agent.label}>
            {agent.label}
          </span>
          <span className="xl:hidden">
            <StatusCell agent={agent} />
          </span>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 xl:contents">
          <span className="font-mono text-[12px] leading-none text-muted">{external ? 'External' : 'Built-in'}</span>
          <span className={`font-mono text-[13px] leading-none text-muted ${external ? '' : 'max-xl:hidden'}`}>
            {external ? `${agent.displayPrefix}...` : ''}
          </span>
          <When iso={agent.createdAt} className="text-[14px] leading-[1.4] text-muted" />
        </div>
        <div className="flex items-center justify-between gap-3 xl:justify-end">
          <span className="max-xl:hidden">
            <StatusCell agent={agent} />
          </span>
          {external && !revoked ? <RevokeControl agentId={agent.agentId} onRevoked={onRevoked} /> : null}
        </div>
      </div>
    </li>
  );
}

function AgentList() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: AGENTS_KEY, queryFn: fetchAgents, gcTime: 0, refetchOnMount: 'always' });

  async function reload() {
    await queryClient.refetchQueries({ queryKey: AGENTS_KEY });
  }

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
    );
  }
  if (query.isError && !query.data) {
    return (
      <div className="flex flex-col items-start gap-2">
        <ErrorLine>{query.error.message}</ErrorLine>
        <Button onClick={() => void query.refetch()}>Try again</Button>
      </div>
    );
  }
  const agents = query.data?.agents ?? [];
  if (agents.length === 0) {
    return <p className="text-[16px] leading-[1.5] text-muted">No agents yet. Create a key above and give it to your agent.</p>;
  }
  return (
    <ul className="flex flex-col max-xl:gap-3 xl:border-t xl:border-line">
      {agents.map((agent) => (
        <AgentRow key={agent.agentId} agent={agent} onRevoked={reload} />
      ))}
    </ul>
  );
}

export function AgentsScreen() {
  // The key is held here only until the person says they have saved it.
  const [token, setToken] = useState<string | null>(null);
  return (
    <PageShell
      label="AGENTS"
      title="Who can ask Ellai to pay"
      intro="Each agent gets its own key. What Ellai learns from your answers applies to all of them, and so does every refusal."
    >
      <div className="flex flex-col gap-8">
        <AddAgent onCreated={setToken} />
        <AgentList />
      </div>
      {token !== null ? <KeyDialog token={token} onClose={() => setToken(null)} /> : null}
    </PageShell>
  );
}
