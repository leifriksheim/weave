import { createElement, useEffect, useRef, type CSSProperties, type ReactElement } from 'react';
import type { WeaveAuth as Auth, WeaveSession } from '../session/auth.js';
import '../elements/weave-auth.js';
import { useWeave } from './context.js';
import type { WeaveAuthElement } from '../elements/weave-auth.js';

export interface WeaveAuthProps {
  /** The flow to draw. Default: the one from the nearest `WeaveProvider`. */
  readonly auth?: Auth;
  /** Someone signed in (a session) or out (null) */
  readonly onSession?: (session: WeaveSession | null) => void;
  readonly className?: string;
  readonly style?: CSSProperties;
}

/**
 * The `<weave-auth>` element, for React. Fits whatever it is put in — a page,
 * a modal, a panel — and draws nothing once someone is signed in.
 */
export function WeaveAuth({ auth: given, onSession, className, style }: WeaveAuthProps): ReactElement {
  const fromProvider = useWeave().auth;
  const auth = given ?? fromProvider;
  if (!auth) throw new Error('<WeaveAuth> needs an auth prop, or a WeaveProvider with one.');
  const ref = useRef<WeaveAuthElement | null>(null);

  useEffect(() => {
    if (ref.current) ref.current.auth = auth;
  }, [auth]);

  useEffect(() => {
    const element = ref.current;
    if (!element || !onSession) return;
    const listener = (event: CustomEvent<{ session: WeaveSession | null }>) => onSession(event.detail.session);
    element.addEventListener('weave-session', listener);
    return () => element.removeEventListener('weave-session', listener);
  }, [onSession]);

  return createElement('weave-auth', {
    // Set before the element connects, so it draws this flow rather than
    // making one of its own from attributes.
    ref: (element: WeaveAuthElement | null) => {
      if (element) element.auth = auth;
      ref.current = element;
    },
    ...(className ? { class: className } : {}),
    ...(style ? { style } : {}),
  });
}
