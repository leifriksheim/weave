import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { SpaceSummary } from '@weaveprotocol/core';
import type { CallAround, CallPeer, CurrentCall, IncomingCall } from '@weaveprotocol/core/calls';
import { useAccount, useCalls, useProfiles } from '@weaveprotocol/core/react';
import { nameOf, peopleFrom } from '../../derive/people';
import { Avatar } from '../Avatar';
import { Icon, type ICONS } from '../Icon';
import { styles, palette } from '../../styles';

/**
 * Calls, drawn once for the whole app, above whatever space is on screen: the
 * call you're in (a panel in the corner, or the whole stage), whoever is
 * ringing you, and the call you were in before a reload. None of it lives in
 * a space's screen, so moving between spaces never touches the call.
 */
export function CallLayer({ spaces, onGoTo }: { spaces: ReadonlyArray<SpaceSummary>; onGoTo: (space: SpaceSummary) => void }) {
  const { state } = useCalls();
  const spaceNamed = (id: string) => spaces.find((s) => s.id === id)?.name ?? 'a space';
  const goTo = (id: string) => {
    const space = spaces.find((s) => s.id === id);
    if (space) onGoTo(space);
  };
  useRingTone(state.ringing.length > 0);

  return (
    <>
      <div className="call-stack" aria-live="polite">
        {state.ringing.map((ring) => (
          <Ringing key={ring.id} ring={ring} spaceName={spaceNamed(ring.space)} inCall={state.current} />
        ))}
        {state.rejoin && !state.current && <Rejoin call={state.rejoin} spaceName={spaceNamed(state.rejoin.space)} />}
      </div>
      {state.current && <CallPanel call={state.current} spaceName={spaceNamed(state.current.space)} onGoTo={() => goTo(state.current!.space)} />}
    </>
  );
}

/** Asks before leaving one call for another. True to go ahead. */
function mayLeaveFor(current: CurrentCall | null, what: string): boolean {
  return !current || globalThis.confirm(`Leave the call you're in and ${what}?`);
}

// ─── The call you're in ──────────────────────────────────────────────

function CallPanel({ call, spaceName, onGoTo }: { call: CurrentCall; spaceName: string; onGoTo: () => void }) {
  const { calls } = useCalls();
  const people = peopleFrom(useProfiles(call.space));
  const [stage, setStage] = useState(false);
  const pip = usePictureInPicture();
  const elapsed = useElapsed(call.joinedAt);
  const canShare = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;
  const act = (fn: () => Promise<void> | void) => () => void Promise.resolve(fn()).catch(() => {});

  const outgoing = call.outgoing && (
    <p style={{ fontSize: 13, color: stage ? '#bbb' : palette.ink.muted }}>
      {call.outgoing.state === 'ringing'
        ? `Ringing ${nameOf(call.outgoing.to, people)}…`
        : call.outgoing.state === 'declined'
          ? `${nameOf(call.outgoing.to, people)} can't talk right now.`
          : `${nameOf(call.outgoing.to, people)} didn't answer.`}
    </p>
  );

  const tiles = <Tiles call={call} people={people} large={stage || pip.window !== null} />;

  return (
    <section aria-label={`Call in ${spaceName}`} className={stage ? 'call-panel call-stage' : 'call-panel'} data-theme={stage ? 'dark' : undefined}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: 4, background: palette.accent.good, flexShrink: 0 }} />
        <button onClick={onGoTo} data-variant="ghost" style={{ ...linkish, color: stage ? '#fff' : palette.ink.strong }} title="Go to this space">
          {spaceName}
        </button>
        <span style={{ fontSize: 12, color: stage ? '#999' : palette.ink.faint, fontVariantNumeric: 'tabular-nums' }}>{elapsed}</span>
        <span style={{ flex: 1 }} />
        {pip.supported && (
          <RoundButton icon="pip" label={pip.window ? 'Back from picture-in-picture' : 'Picture-in-picture'} on={pip.window !== null} dark={stage} onClick={pip.toggle} />
        )}
        <RoundButton icon={stage ? 'shrink' : 'expand'} label={stage ? 'Make smaller' : 'Make bigger'} dark={stage} onClick={() => setStage(!stage)} />
      </header>

      {outgoing}
      {call.problem && <p style={{ fontSize: 13, color: palette.accent.danger }}>{call.problem}</p>}

      {pip.window ? (
        <>
          <p style={{ fontSize: 13, color: stage ? '#bbb' : palette.ink.muted }}>Showing in picture-in-picture.</p>
          {createPortal(<div className="call-pip">{tiles}</div>, pip.window.document.body)}
        </>
      ) : (
        tiles
      )}

      <footer style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
        <RoundButton icon={call.muted ? 'micOff' : 'mic'} label={call.muted ? 'Unmute' : 'Mute'} on={call.muted} dark={stage} big onClick={() => calls?.setMuted(!call.muted)} />
        <RoundButton icon={call.camera && !call.sharing ? 'camera' : 'cameraOff'} label={call.camera ? 'Turn camera off' : 'Turn camera on'} on={!call.camera} dark={stage} big onClick={act(() => calls?.setCamera(!call.camera || call.sharing))} />
        {canShare && (
          <RoundButton icon="screen" label={call.sharing ? 'Stop sharing' : 'Share your screen'} on={call.sharing} dark={stage} big onClick={act(() => (call.sharing ? calls?.stopSharing() : calls?.shareScreen()))} />
        )}
        <RoundButton icon="hangUp" label="Leave the call" danger big onClick={act(() => calls?.leave())} />
      </footer>
    </section>
  );
}

function Tiles({ call, people, large }: { call: CurrentCall; people: ReturnType<typeof peopleFrom>; large: boolean }) {
  const { did: me } = useAccount();
  const others = call.people;
  return (
    <div className="call-tiles" data-count={Math.min(others.length + 1, 6)} data-large={large || undefined}>
      {others.map((person) => (
        <Tile key={person.peer} name={nameOf(person.account, people)} did={person.account} stream={person.stream} camera={person.camera} muted={person.muted} note={noteFor(person)} />
      ))}
      <Tile name="You" did={me} stream={call.local} camera={call.camera} muted={call.muted} self />
      {others.length === 0 && !call.outgoing && <p style={{ fontSize: 13, color: palette.ink.muted, alignSelf: 'center' }}>Nobody else here yet.</p>}
    </div>
  );
}

const noteFor = (person: CallPeer) => (person.connection === 'connecting' ? 'Connecting…' : person.connection === 'failed' ? "Can't connect" : null);

function Tile({ name, did, stream, camera, muted, self = false, note = null }: { name: string; did: string; stream: MediaStream | null; camera: boolean; muted: boolean; self?: boolean; note?: string | null }) {
  const showVideo = camera && !!stream?.getVideoTracks().length;
  return (
    <figure className="call-tile">
      {/* Always there when there is a stream, so their voice plays with the camera off too. Your own is silent. */}
      {stream && <Video stream={stream} muted={self} mirror={self} hidden={!showVideo} />}
      {!showVideo && (
        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
          <Avatar did={did} size={40} />
        </span>
      )}
      <figcaption className="call-name">
        {muted && <Icon name="micOff" size={12} />}
        {name}
        {note && <span style={{ opacity: 0.7 }}> · {note}</span>}
      </figcaption>
    </figure>
  );
}

function Video({ stream, muted, mirror, hidden }: { stream: MediaStream; muted: boolean; mirror: boolean; hidden: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (video && video.srcObject !== stream) video.srcObject = stream;
  }, [stream]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', transform: mirror ? 'scaleX(-1)' : undefined, opacity: hidden ? 0 : 1 }}
    />
  );
}

// ─── Someone ringing ─────────────────────────────────────────────────

function Ringing({ ring, spaceName, inCall }: { ring: IncomingCall; spaceName: string; inCall: CurrentCall | null }) {
  const { calls } = useCalls();
  const people = peopleFrom(useProfiles(ring.space));
  const [busy, setBusy] = useState(false);
  const answer = (video: boolean) => {
    if (!calls || !mayLeaveFor(inCall, 'answer this one')) return;
    setBusy(true);
    void calls.answer(ring.id, { video }).catch(() => setBusy(false));
  };
  return (
    <div className="call-card" role="alertdialog" aria-label={`${nameOf(ring.from, people)} is calling`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="call-ringing">
          <Avatar did={ring.from} size={36} />
        </span>
        <div style={{ minWidth: 0 }}>
          <p style={{ fontWeight: 600, color: palette.ink.strong }}>{nameOf(ring.from, people)} is calling</p>
          <p style={{ fontSize: 13, color: palette.ink.muted }}>in {spaceName}</p>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => void calls?.decline(ring.id)} disabled={busy} data-variant="danger" style={{ ...styles.smallButton, flex: 1, color: palette.accent.danger }}>
          Decline
        </button>
        <button onClick={() => answer(false)} disabled={busy} data-variant="quiet" style={{ ...styles.smallButton, flex: 1 }}>
          Answer
        </button>
        <button onClick={() => answer(true)} disabled={busy} data-variant="primary" style={{ ...styles.smallButton, flex: 1, background: palette.ink.strong, color: '#fff', border: `1px solid ${palette.ink.strong}` }}>
          With video
        </button>
      </div>
    </div>
  );
}

function Rejoin({ call, spaceName }: { call: CallAround; spaceName: string }) {
  const { calls } = useCalls();
  return (
    <div className="call-card">
      <p style={{ color: palette.ink.strong }}>
        You were in a call in <strong>{spaceName}</strong>. It's still going on.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => calls?.forgetRejoin()} data-variant="quiet" style={{ ...styles.smallButton, flex: 1 }}>
          Dismiss
        </button>
        <button onClick={() => void calls?.start(call.space, { call: call.id }).catch(() => {})} data-variant="primary" style={{ ...styles.smallButton, flex: 1, background: palette.ink.strong, color: '#fff', border: `1px solid ${palette.ink.strong}` }}>
          Rejoin
        </button>
      </div>
    </div>
  );
}

// ─── In a space ──────────────────────────────────────────────────────

/** "Start a call", or "Join call · 3" when one is going on — for the top of a space */
export function CallButton({ space }: { space: SpaceSummary }) {
  const { state, calls } = useCalls();
  const [busy, setBusy] = useState(false);
  if (!calls || !space.writable) return null;
  const here = state.current?.space === space.id;
  const going = state.around.find((c) => c.space === space.id);
  if (here) {
    return (
      <span style={{ ...styles.badge, display: 'inline-flex', alignItems: 'center', gap: 6, color: palette.accent.good, border: `1px solid ${palette.accent.good}` }}>
        <Icon name="phone" size={12} /> In the call
      </span>
    );
  }
  const start = () => {
    if (!mayLeaveFor(state.current, going ? 'join this one' : 'start one here')) return;
    setBusy(true);
    void calls.start(space.id).finally(() => setBusy(false));
  };
  return (
    <button
      onClick={start}
      disabled={busy}
      data-variant={going ? 'primary' : 'quiet'}
      style={{
        ...styles.smallButton,
        height: 28,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        ...(going ? { background: palette.accent.good, border: `1px solid ${palette.accent.good}`, color: '#fff' } : {}),
      }}
      title={space.visibility === 'public' ? 'Anyone who joins this space with a role can join the call' : 'Only people in this space can join'}
    >
      <Icon name="phone" size={12} />
      {going ? `Join call · ${going.people.length}` : 'Start a call'}
    </button>
  );
}

/** Rings one person in a space — beside their name */
export function RingButton({ space, did, name }: { space: SpaceSummary; did: string; name: string }) {
  const { state, calls } = useCalls();
  if (!calls || !space.writable) return null;
  const ringing = state.current?.outgoing?.to === did && state.current.outgoing.state === 'ringing';
  const withThem = state.current?.people.some((p) => p.account === did);
  return (
    <button
      onClick={() => {
        if (!mayLeaveFor(state.current?.space === space.id ? null : state.current, `call ${name}`)) return;
        void calls.ring(space.id, did).catch(() => {});
      }}
      disabled={ringing || withThem}
      data-variant="quiet"
      style={{ ...styles.smallButton, display: 'inline-flex', alignItems: 'center', gap: 6 }}
      title={`Call ${name}. It rings wherever they have this space open.`}
    >
      <Icon name="phone" size={12} />
      {withThem ? 'In call' : ringing ? 'Ringing…' : 'Call'}
    </button>
  );
}

/** The spaces with a call going on, for the rail: whether you're in it, or others are */
export function useCallSpaces(): { readonly mine: string | null; readonly others: ReadonlySet<string> } {
  const { state } = useCalls();
  return { mine: state.current?.space ?? null, others: new Set(state.around.map((c) => c.space)) };
}

// ─── Pieces ──────────────────────────────────────────────────────────

function RoundButton({ icon, label, onClick, on = false, danger = false, dark = false, big = false }: { icon: keyof typeof ICONS; label: string; onClick: () => void; on?: boolean; danger?: boolean; dark?: boolean; big?: boolean }) {
  const size = big ? 40 : 28;
  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: size / 2,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: `1px solid ${danger ? palette.accent.danger : dark ? '#333' : palette.surface.line}`,
    background: danger ? palette.accent.danger : on ? (dark ? '#fff' : palette.ink.strong) : dark ? '#1a1a1a' : palette.surface.card,
    color: danger ? '#fff' : on ? (dark ? '#000' : '#fff') : dark ? '#eee' : palette.ink.body,
    padding: 0,
    flexShrink: 0,
  };
  return (
    <button onClick={onClick} aria-label={label} title={label} aria-pressed={on || undefined} style={style}>
      <Icon name={icon} size={big ? 18 : 14} />
    </button>
  );
}

const linkish: CSSProperties = { border: 'none', background: 'none', padding: 0, fontSize: 14, fontWeight: 600, cursor: 'pointer', minHeight: 0, textAlign: 'left' };

function useElapsed(since: number): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const two = (n: number) => String(n).padStart(2, '0');
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${two(Math.floor(seconds / 60) % 60)}:${two(seconds % 60)}` : `${two(Math.floor(seconds / 60))}:${two(seconds % 60)}`;
}

/**
 * A window of its own that stays on top when you switch tabs, where the
 * browser has Document Picture-in-Picture (Chrome, Edge). The page's styles
 * are copied in, so the tiles look the same there.
 */
function usePictureInPicture(): { supported: boolean; window: Window | null; toggle: () => void } {
  const api = (globalThis as { documentPictureInPicture?: { requestWindow(options: { width: number; height: number }): Promise<Window> } }).documentPictureInPicture;
  const [pip, setPip] = useState<Window | null>(null);
  useEffect(() => () => pip?.close(), [pip]);
  const toggle = () => {
    if (pip) {
      pip.close();
      setPip(null);
      return;
    }
    void api
      ?.requestWindow({ width: 360, height: 260 })
      .then((opened) => {
        for (const sheet of document.querySelectorAll('style, link[rel="stylesheet"]')) opened.document.head.appendChild(sheet.cloneNode(true));
        opened.document.body.style.margin = '0';
        opened.document.body.style.background = '#000';
        opened.addEventListener('pagehide', () => setPip(null));
        setPip(opened);
      })
      .catch(() => {});
  };
  return { supported: !!api, window: pip, toggle };
}

/** A soft two-note ring while someone is calling — made on the spot, no sound file */
function useRingTone(ringing: boolean) {
  useEffect(() => {
    if (!ringing || typeof AudioContext === 'undefined') return;
    let context: AudioContext;
    try {
      context = new AudioContext();
    } catch {
      return;
    }
    const chime = () => {
      if (context.state === 'suspended') void context.resume().catch(() => {});
      [660, 880].forEach((hz, i) => {
        const at = context.currentTime + i * 0.18;
        const tone = context.createOscillator();
        const gain = context.createGain();
        tone.frequency.value = hz;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.08, at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
        tone.connect(gain).connect(context.destination);
        tone.start(at);
        tone.stop(at + 0.4);
      });
    };
    chime();
    const timer = setInterval(chime, 2000);
    return () => {
      clearInterval(timer);
      void context.close().catch(() => {});
    };
  }, [ringing]);
}

