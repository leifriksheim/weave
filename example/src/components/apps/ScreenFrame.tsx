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
 */
export function ScreenFrame({ spaceId, collections, screen, title }: { spaceId: string; collections: ReadonlyArray<string>; screen: string; title: string }) {
  const node = useNode();
  const account = useAccount();
  const frame = useRef<HTMLIFrameElement>(null);
  const [stopped, setStopped] = useState(false);
  // A new screen, or a new app, starts a new frame.
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
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
      bridge = createScreenBridge({ node, spaceId, collections, port: channel.port1 });
      target.postMessage(
        { weave: 'load', document: screenDocument(screen), me: { did: node.did, name: account.name }, collections: [...collections] },
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
  }, [node, spaceId, screen, collections.join('|'), account.name, generation]);

  if (stopped) {
    return (
      <div style={{ ...styles.errorBox, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p style={styles.error}>This screen tried to open another page, so it was stopped.</p>
        <p style={styles.errorHint}>It can't reach your data from there. Reload it to try again, or show the records as lists instead.</p>
        <button onClick={() => setGeneration((n) => n + 1)} data-variant="quiet" style={{ ...styles.smallButton, alignSelf: 'flex-start' }}>
          Reload the screen
        </button>
      </div>
    );
  }

  return (
    <iframe
      key={generation}
      ref={frame}
      title={title}
      src="/screen.html"
      // Scripts only. No allow-same-origin: it must not be this site. No popups, forms or navigation of this page.
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      style={{ width: '100%', height: 'min(78vh, 760px)', border: `1px solid ${palette.surface.line}`, borderRadius: 12, background: palette.surface.card }}
    />
  );
}
