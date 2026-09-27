import { createContext, createElement, useContext, useEffect, useState, useSyncExternalStore, type ReactElement, type ReactNode } from 'react';
import { createCalls, type Calls, type CallsOptions, type CallsState } from '../calls/calls.js';
import { useNode } from './context.js';

const CallsContext = createContext<Calls | null>(null);

const EMPTY: CallsState = Object.freeze({ current: null, ringing: [], around: [], rejoin: null });
const never = () => () => {};
const empty = () => EMPTY;

/**
 * Calls for everything below it: one per node, so a call keeps going while
 * the screens under it come and go. Put it above whatever changes when
 * someone moves between spaces.
 */
export function CallsProvider({ children, options }: { readonly children?: ReactNode; readonly options?: CallsOptions }): ReactElement {
  const node = useNode();
  const [calls, setCalls] = useState<Calls | null>(null);
  useEffect(() => {
    const made = createCalls(node, options);
    setCalls(made);
    return () => {
      setCalls(null);
      void made.close();
    };
    // Options are read once, when the node is new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node]);
  return createElement(CallsContext.Provider, { value: calls }, children);
}

/**
 * What's going on with calls — the one you're in, who's ringing, calls in
 * your open spaces — and the calls themselves, to start, answer or leave
 * one. Null calls until the provider has made them.
 */
export function useCalls(): { readonly state: CallsState; readonly calls: Calls | null } {
  const calls = useContext(CallsContext);
  const state = useSyncExternalStore(calls ? calls.subscribe : never, calls ? calls.getState : empty, calls ? calls.getState : empty);
  return { state, calls };
}
