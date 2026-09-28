import {
  createElement,
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
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
  const [element, setElement] = useState<WeaveAuthElement | null>(null);

  // Sets the flow before the element connects, so it draws this one rather
  // than making one of its own from attributes; and again when it changes.
  const attach = useCallback(
    (attached: WeaveAuthElement | null) => {
      if (attached) attached.auth = auth;
      setElement(attached);
    },
    [auth],
  );

  useEffect(() => {
    if (!element || !onSession) return;
    const listener = (event: CustomEvent<{ session: WeaveSession | null }>) =>
      onSession(event.detail.session);
    element.addEventListener('weave-session', listener);
    return () => element.removeEventListener('weave-session', listener);
  }, [element, onSession]);

  return createElement('weave-auth', {
    ref: attach,
    ...(className ? { class: className } : {}),
    ...(style ? { style } : {}),
  });
}
