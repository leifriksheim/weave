import { useEffect, useRef, useState } from 'react';
import { useAccount, useNode } from '@weaveprotocol/core/react';
import { createScreenBridge, screenDocument, type ScreenBridge } from '@weaveprotocol/core/schemas';
import { styles, palette } from '../../styles';

/**
 * An app's own screen, run sealed.
 *
 * The frame is sandboxed to scripts alone — an opaque origin, so it can't
 * touch this page, its storage or its keys — and the page it loads
 * (`/screen.html`) takes the network away. The screen gets a message port to
 * a bridge that reads and writes this app's collections, in this space, as
 * the person looking. It is handed over once: a second "ready" means the
 * frame went somewhere else, and the screen is stopped.
 *
 * A screen whose definition names origins (`network`) reaches them only once
 * the person looking says yes: it runs as them, so what it sends is theirs.
 * The answer is kept on this device for that exact list; a new origin asks
 * again. Saying no runs it sealed.
 */
export function ScreenFrame({
  spaceId,
  collection,
  collections,
  screen,
  network,
  title,
}: {
  spaceId: string;
  /** The collection whose definition carries the screen */
  collection: string;
  collections: ReadonlyArray<string>;
  screen: string;
  network: ReadonlyArray<string>;
  title: string;
}) {
  const node = useNode();
  const account = useAccount();
  const frame = useRef<HTMLIFrameElement>(null);
  const [stopped, setStopped] = useState(false);
  // A new screen, or a new app, starts a new frame.
  const [generation, setGeneration] = useState(0);
  const origins = [...network].sort().join(' ');
  const consentKey = `weave.screen-network:${node.did}:${spaceId}:${collection}`;
  const [answer, setAnswer] = useState<'yes' | 'no' | null>(() => (origins ? readConsent(consentKey, origins) : 'no'));
  useEffect(() => setAnswer(origins ? readConsent(consentKey, origins) : 'no'), [consentKey, origins]);
  const answerWith = (value: 'yes' | 'no') => {
    try {
      globalThis.localStorage?.setItem(consentKey, JSON.stringify({ origins, answer: value }));
    } catch {
      // Not remembered: it asks again next time.
    }
    setAnswer(value);
  };

  useEffect(() => {
    if (answer === null) return;
    setStopped(false);
    let bridge: ScreenBridge | null = null;
    let handedOver = false;
    const onMessage = (event: MessageEvent) => {
      const target = frame.current?.contentWindow;
      if (!target || event.source !== target || (event.data as { weave?: unknown } | null)?.weave !== 'ready') return;
      if (handedOver) {
        // Only the page we loaded says ready, and only once. Anything after that navigated the frame.
        bridge?.close();
        bridge = null;
        setStopped(true);
        return;
      }
      handedOver = true;
      const channel = new MessageChannel();
      bridge = createScreenBridge({
        node,
        spaceId,
        collections,
        port: channel.port1,
      });
      target.postMessage(
        {
          weave: 'load',
          document: screenDocument(screen, answer === 'yes' ? network : []),
          me: { did: node.did, name: account.name },
          collections: [...collections],
        },
        // The frame's origin is opaque, so it can't be named. The port is what carries anything that matters.
        '*',
        [channel.port2],
      );
    };
    globalThis.addEventListener('message', onMessage);
    return () => {
      globalThis.removeEventListener('message', onMessage);
      bridge?.close();
    };
  }, [node, spaceId, screen, collections.join('|'), account.name, generation, answer, origins]);

  if (answer === null) {
    return (
      <div
        style={{
          ...styles.errorBox,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          background: palette.surface.sunken,
          borderColor: palette.surface.line,
        }}
      >
        <p style={{ fontSize: 14, color: palette.ink.strong, lineHeight: 1.5 }}>
          This screen wants to connect to <strong>{network.map((origin) => origin.replace(/^[a-z]+:\/\//, '')).join(', ')}</strong>.
        </p>
        <p style={{ fontSize: 13, color: palette.ink.body, lineHeight: 1.5 }}>
          It runs as you, so it could send there anything you can see in it. Nothing else on the internet is reachable. Without it, the screen runs sealed and
          may do less.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => answerWith('yes')} data-variant="primary" style={styles.smallButton}>
            Allow
          </button>
          <button onClick={() => answerWith('no')} data-variant="quiet" style={styles.smallButton}>
            Keep it sealed
          </button>
        </div>
      </div>
    );
  }

  if (stopped) {
    return (
      <div
        style={{
          ...styles.errorBox,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <p style={styles.error}>This screen tried to open another page, so it was stopped.</p>
        <p style={styles.errorHint}>It can't reach your data from there. Reload it to try again, or show the records as lists instead.</p>
        <button onClick={() => setGeneration((n) => n + 1)} data-variant="quiet" style={{ ...styles.smallButton, alignSelf: 'flex-start' }}>
          Reload the screen
        </button>
      </div>
    );
  }

  const hosts = network.map((origin) => origin.replace(/^[a-z]+:\/\//, '')).join(', ');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {origins && (
        <p
          style={{
            fontSize: 12,
            color: palette.ink.muted,
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          {answer === 'yes' ? `Connects to ${hosts}.` : `Sealed: not connecting to ${hosts}.`}
          <button onClick={() => answerWith(answer === 'yes' ? 'no' : 'yes')} data-variant="ghost" style={{ ...styles.linkButton, fontSize: 12, padding: 0 }}>
            {answer === 'yes' ? 'Seal it' : 'Allow'}
          </button>
        </p>
      )}
      <iframe
        ref={frame}
        title={title}
        src="/screen.html"
        // Scripts only. No allow-same-origin: it must not be this site. No popups, forms or navigation of this page.
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        key={`${generation}:${answer}`}
        style={{
          width: '100%',
          height: 'min(78vh, 760px)',
          border: `1px solid ${palette.surface.line}`,
          borderRadius: 12,
          background: palette.surface.card,
        }}
      />
    </div>
  );
}

/** What this person said to a screen's list of origins, when it was this same list */
function readConsent(key: string, origins: string): 'yes' | 'no' | null {
  try {
    const kept = JSON.parse(globalThis.localStorage?.getItem(key) ?? 'null') as { origins?: unknown; answer?: unknown } | null;
    return kept?.origins === origins && (kept.answer === 'yes' || kept.answer === 'no') ? kept.answer : null;
  } catch {
    return null;
  }
}
