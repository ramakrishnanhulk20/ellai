'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { fetchOverview, fetchQuestions, onSignedOut, type Question } from './api.js';

export type Verdict = 'approve' | 'refuse';

// Every private query lives under this key, so signing in or out can drop all of it and nothing
// of the last owner shows for the next. The wallet kit's own queries sit outside it.
export const APP_KEY = 'ellai';
export const OVERVIEW_KEY = [APP_KEY, 'overview'] as const;
export const QUESTIONS_KEY = [APP_KEY, 'questions'] as const;

const QUESTIONS_REFRESH_MS = 30_000;

type Session = {
  signedOut: boolean;
  markSignedOut: () => void;
  markSignedIn: () => void;
  answers: Readonly<Record<string, Verdict>>;
  recordAnswer: (decisionId: string, verdict: Verdict) => void;
};

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [signedOut, setSignedOut] = useState(false);
  const [answers, setAnswers] = useState<Readonly<Record<string, Verdict>>>({});

  const dropPrivateData = useCallback(() => {
    queryClient.removeQueries({ queryKey: [APP_KEY] });
    setAnswers({});
  }, [queryClient]);

  const markSignedOut = useCallback(() => {
    dropPrivateData();
    setSignedOut(true);
  }, [dropPrivateData]);

  const markSignedIn = useCallback(() => setSignedOut(false), []);

  const recordAnswer = useCallback((decisionId: string, verdict: Verdict) => {
    setAnswers((current) => ({ ...current, [decisionId]: verdict }));
  }, []);

  useEffect(() => onSignedOut(markSignedOut), [markSignedOut]);

  const value = useMemo(
    () => ({ signedOut, markSignedOut, markSignedIn, answers, recordAnswer }),
    [signedOut, markSignedOut, markSignedIn, answers, recordAnswer],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (session === null) throw new Error('useSession needs the app providers around it');
  return session;
}

/**
 * The overview costs a Sui read, so it loads once per app load and again only when a person asks
 * or an action changes it. It is also how the app learns whether a session is open.
 */
export function useOverview() {
  const { signedOut } = useSession();
  return useQuery({
    queryKey: OVERVIEW_KEY,
    // No abort signal on purpose: a read that has started counts against the chain budget, so it is
    // allowed to finish even when the page that asked is replaced mid-flight.
    queryFn: () => fetchOverview(),
    enabled: !signedOut,
    staleTime: Infinity,
    gcTime: Infinity,
    retryOnMount: false,
  });
}

/** The unanswered questions. They cost no chain read, so they refresh every 30 seconds while the tab is visible. */
export function useQuestions() {
  const { signedOut, answers } = useSession();
  const query = useQuery({
    queryKey: QUESTIONS_KEY,
    queryFn: ({ signal }) => fetchQuestions(signal),
    enabled: !signedOut,
    refetchInterval: QUESTIONS_REFRESH_MS,
  });
  const all: Question[] = query.data?.questions ?? [];
  const waiting = all.filter((question) => answers[question.decisionId] === undefined);
  return { query, all, waiting, answers };
}
