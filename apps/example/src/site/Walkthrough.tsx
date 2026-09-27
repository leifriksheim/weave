import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * How Weave works, in six steps with a small animation each: an account, where
 * data lives, more devices, apps, sharing, and staying in sync. The tabs play
 * through on their own while the section is on screen, until someone picks one.
 *
 * The drawings animate with SVG's own <animate> and <animateMotion>. Every
 * animation in a scene shares one loop, and says when it happens as a share of
 * it, so a scene reads as a timeline.
 */

/** Seconds per loop of a scene; a tab stays a little longer than that */
const LOOP = 6;
const DWELL = LOOP + 1.5;

type Span = readonly [start: number, end: number];

const num = (n: number) => +n.toFixed(3);

/** Opacity values and times that show something only during `[s, e]` of the loop */
function during([s, e]: Span, fade = 0.025) {
  if (s <= 0 && e >= 1) return { values: '1;1', keyTimes: '0;1' };
  if (s <= 0) return { values: '1;1;0;0', keyTimes: `0;${num(e - fade)};${num(e)};1` };
  if (e >= 1) return { values: '0;0;1;1', keyTimes: `0;${num(s)};${num(s + fade)};1` };
  return { values: '0;0;1;1;0;0', keyTimes: `0;${num(s)};${num(s + fade)};${num(e - fade)};${num(e)};1` };
}

function Show({ t, children }: { t: Span; children: ReactNode }) {
  return (
    <g opacity={0}>
      <animate attributeName="opacity" dur={`${LOOP}s`} repeatCount="indefinite" {...during(t)} />
      {children}
    </g>
  );
}

/** Moves its children (drawn around 0,0) along `path` during `t`, visible only then */
function Move({ path, t: [s, e], children }: { path: string; t: Span; children: ReactNode }) {
  return (
    <g opacity={0}>
      <animateMotion
        path={path}
        dur={`${LOOP}s`}
        repeatCount="indefinite"
        calcMode="spline"
        keyPoints="0;0;1;1"
        keyTimes={`0;${num(s)};${num(e)};1`}
        keySplines="0 0 1 1;.45 0 .25 1;0 0 1 1"
      />
      <animate attributeName="opacity" dur={`${LOOP}s`} repeatCount="indefinite" {...during([s, e + 0.01])} />
      {children}
    </g>
  );
}

// ─── Things to draw ─────────────────────────────────────────────────

const INK = '#000';
const LINE = '#d4d4d4';
const MUTED = '#666';

function Laptop({ x, y, children }: { x: number; y: number; children?: ReactNode }) {
  return (
    <g>
      <rect x={x} y={y} width={128} height={84} rx={6} fill="#fff" stroke={INK} strokeWidth={1.5} />
      <path d={`M${x - 12} ${y + 88} h152 l-6 8 h-140 z`} fill="#fff" stroke={INK} strokeWidth={1.5} strokeLinejoin="round" />
      {children}
    </g>
  );
}

function Phone({ x, y, children }: { x: number; y: number; children?: ReactNode }) {
  return (
    <g>
      <rect x={x} y={y} width={52} height={96} rx={10} fill="#fff" stroke={INK} strokeWidth={1.5} />
      <line x1={x + 20} y1={y + 8} x2={x + 32} y2={y + 8} stroke={INK} strokeWidth={1.5} strokeLinecap="round" />
      {children}
    </g>
  );
}

function Label({ x, y, children, anchor = 'middle' }: { x: number; y: number; children: ReactNode; anchor?: 'start' | 'middle' | 'end' }) {
  return (
    <text x={x} y={y} textAnchor={anchor} fontSize={11} fill={MUTED} fontFamily="inherit">
      {children}
    </text>
  );
}

function Key({ x = 0, y = 0 }: { x?: number; y?: number }) {
  return (
    <g transform={`translate(${x} ${y})`} fill="none" stroke={INK} strokeWidth={1.5} strokeLinecap="round">
      <circle cx={-7} cy={0} r={5} fill="#fff" />
      <path d="M-2 0h13M7 0v4M11 0v4" />
    </g>
  );
}

/** A record: a small card with two lines of text */
function Record({ x = 0, y = 0 }: { x?: number; y?: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x={-13} y={-9} width={26} height={18} rx={3} fill="#fff" stroke={INK} strokeWidth={1.5} />
      <path d="M-7 -3h14M-7 3h9" stroke={INK} strokeWidth={1.2} strokeLinecap="round" />
    </g>
  );
}

/** A record once it's encrypted: black, with a lock */
function Sealed({ x = 0, y = 0 }: { x?: number; y?: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x={-13} y={-9} width={26} height={18} rx={3} fill={INK} />
      <rect x={-4} y={-1} width={8} height={6} rx={1} fill="#fff" />
      <path d="M-2.5 -1v-2a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="#fff" strokeWidth={1.2} />
    </g>
  );
}

function Dot() {
  return <circle r={3.5} fill={INK} />;
}

// ─── The scenes ─────────────────────────────────────────────────────

/** 1. A password made on the device; the account comes from it, and it's kept in a password manager */
function AccountScene() {
  return (
    <>
      <Laptop x={56} y={60}>
        <Label x={120} y={84}>
          New account
        </Label>
        <rect x={72} y={94} width={96} height={22} rx={4} fill="#fff" stroke={LINE} />
        {Array.from({ length: 8 }, (_, i) => (
          <Show key={i} t={[0.05 + i * 0.035, 0.95]}>
            <circle cx={82 + i * 10.5} cy={105} r={2.6} fill={INK} />
          </Show>
        ))}
      </Laptop>
      <Label x={120} y={176}>
        Your device
      </Label>

      <rect x={300} y={70} width={130} height={74} rx={10} fill="#fafafa" stroke={LINE} />
      <Label x={365} y={92}>
        Password manager
      </Label>
      <rect x={322} y={104} width={86} height={24} rx={5} fill="#fff" stroke={LINE} />
      <Label x={365} y={176}>
        or a passkey
      </Label>

      <Move path="M150 105 C 220 105, 260 116, 356 116" t={[0.4, 0.62]}>
        <Key x={0} y={0} />
      </Move>
      <Show t={[0.62, 0.95]}>
        <Key x={356} y={116} />
        <circle cx={392} cy={116} r={3} fill={INK} />
      </Show>
    </>
  );
}

/** 2. Saved on your own computer first, encrypted, and it doesn't need the internet */
function StorageScene() {
  const starts = [0.06, 0.32, 0.58];
  return (
    <>
      <rect x={20} y={22} width={440} height={196} rx={14} fill="none" stroke={LINE} strokeDasharray="4 4" />
      <Label x={36} y={42} anchor="start">
        Your computer
      </Label>

      {/* Offline is fine */}
      <g transform="translate(424 38)" fill="none" stroke={MUTED} strokeWidth={1.4} strokeLinecap="round">
        <path d="M-10 -2a14 14 0 0 1 20 0M-6 2a8 8 0 0 1 12 0" />
        <circle cx={0} cy={6} r={1} fill={MUTED} />
        <path d="M-11 -8l22 18" stroke={INK} />
      </g>
      <Label x={404} y={42} anchor="end">
        offline
      </Label>

      {/* The app */}
      <rect x={52} y={66} width={132} height={112} rx={8} fill="#fff" stroke={INK} strokeWidth={1.5} />
      <line x1={52} y1={84} x2={184} y2={84} stroke={LINE} />
      {[64, 72, 80].map((cx) => (
        <circle key={cx} cx={cx} cy={75} r={2.2} fill={LINE} />
      ))}
      <Label x={118} y={196}>
        An app
      </Label>

      {/* The pod */}
      <path d="M300 82 h40 l10 10 h80 v84 h-130 z" fill="#fafafa" stroke={INK} strokeWidth={1.5} strokeLinejoin="round" />
      <Label x={365} y={196}>
        Your pod, or the browser
      </Label>

      {starts.map((s, i) => (
        <g key={s}>
          <Show t={[s, s + 0.08]}>
            <Record x={118} y={116 + (i - 1) * 22} />
          </Show>
          <Move path={`M118 ${116 + (i - 1) * 22} L 242 128`} t={[s + 0.08, s + 0.17]}>
            <Record />
          </Move>
          <Move path={`M242 128 L ${340 + i * 30} 150`} t={[s + 0.17, s + 0.26]}>
            <Sealed />
          </Move>
          <Show t={[s + 0.26, 0.95]}>
            <Sealed x={340 + i * 30} y={150} />
          </Show>
        </g>
      ))}
    </>
  );
}

const QR = [
  [1, 1, 1, 0, 1],
  [1, 0, 1, 1, 0],
  [1, 1, 1, 0, 1],
  [0, 1, 0, 1, 1],
  [1, 0, 1, 1, 1],
];

/** 3. A phone scans a code on the laptop, and after that changes go both ways */
function DevicesScene() {
  return (
    <>
      <Laptop x={48} y={60}>
        <Show t={[0, 0.4]}>
          {QR.flatMap((row, r) =>
            row.map((on, c) => (on ? <rect key={`${r}-${c}`} x={94 + c * 7.5} y={82 + r * 7.5} width={6.5} height={6.5} fill={INK} /> : null)),
          )}
        </Show>
        <Show t={[0.4, 0.95]}>
          <Record x={112} y={102} />
        </Show>
      </Laptop>
      <Label x={112} y={176}>
        Laptop
      </Label>

      <Phone x={362} y={54}>
        <g opacity={0}>
          <animate attributeName="opacity" dur={`${LOOP}s`} repeatCount="indefinite" {...during([0.06, 0.34])} />
          <line x1={370} x2={406} stroke={INK} strokeWidth={1.5}>
            <animate attributeName="y1" dur="1s" repeatCount="indefinite" values="72;132;72" />
            <animate attributeName="y2" dur="1s" repeatCount="indefinite" values="72;132;72" />
          </line>
        </g>
        <Show t={[0.34, 0.95]}>
          <Record x={388} y={102} />
        </Show>
      </Phone>
      <Label x={388} y={176}>
        Phone
      </Label>

      <Show t={[0.4, 0.95]}>
        <line x1={196} y1={102} x2={352} y2={102} stroke={LINE} strokeDasharray="4 4" />
      </Show>
      {[0.45, 0.62, 0.79].map((s, i) => (
        <Move key={s} path={i % 2 ? 'M352 102 L 196 102' : 'M196 102 L 352 102'} t={[s, s + 0.13]}>
          <Dot />
        </Move>
      ))}
    </>
  );
}

/** 4. The account home hands each app a signed note; the app never gets the password */
function AppsScene() {
  const apps = ['Chat', 'Tasks', 'Notes'];
  const starts = [0.08, 0.34, 0.6];
  return (
    <>
      <rect x={36} y={74} width={140} height={92} rx={10} fill="#fafafa" stroke={INK} strokeWidth={1.5} />
      <Label x={106} y={98}>
        Account home
      </Label>
      <Key x={106} y={118} />
      {starts.map((s) => (
        <Show key={s} t={[s - 0.05, s + 0.02]}>
          <rect x={76} y={134} width={60} height={20} rx={5} fill={INK} />
          <text x={106} y={148} textAnchor="middle" fontSize={11} fill="#fff" fontFamily="inherit">
            Allow
          </text>
        </Show>
      ))}
      <Label x={106} y={192}>
        Only it knows your password
      </Label>

      {apps.map((name, i) => {
        const y = 30 + i * 66;
        const s = starts[i] ?? 0;
        return (
          <g key={name}>
            <rect x={320} y={y} width={124} height={50} rx={8} fill="#fff" stroke={INK} strokeWidth={1.5} />
            <text x={338} y={y + 30} fontSize={12} fill={INK} fontFamily="inherit">
              {name}
            </text>
            <Move path={`M176 120 C 240 120, 250 ${y + 25}, 296 ${y + 25}`} t={[s + 0.02, s + 0.18]}>
              <Note />
            </Move>
            <Show t={[s + 0.18, 0.95]}>
              <Note x={414} y={y + 25} />
            </Show>
          </g>
        );
      })}
    </>
  );
}

/** A signed note: a slip of paper with a seal */
function Note({ x = 0, y = 0 }: { x?: number; y?: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x={-12} y={-9} width={24} height={18} rx={2} fill="#fff" stroke={INK} strokeWidth={1.5} />
      <path d="M-7 -3h9" stroke={INK} strokeWidth={1.2} strokeLinecap="round" />
      <circle cx={5} cy={3} r={3} fill={INK} />
    </g>
  );
}

/** 5. An invite link with the key inside, then one space both people write to */
function SharingScene() {
  return (
    <>
      <Laptop x={40} y={80}>
        <Show t={[0.38, 0.95]}>
          <Label x={104} y={104}>
            Trip
          </Label>
          <Record x={104} y={126} />
        </Show>
      </Laptop>
      <Label x={104} y={196}>
        You
      </Label>
      <Laptop x={312} y={80}>
        <Show t={[0.38, 0.95]}>
          <Label x={376} y={104}>
            Trip
          </Label>
          <Record x={376} y={126} />
        </Show>
      </Laptop>
      <Label x={376} y={196}>
        A friend
      </Label>

      <Move path="M104 64 Q 240 -6 376 64" t={[0.06, 0.34]}>
        <rect x={-34} y={-12} width={68} height={24} rx={12} fill="#fff" stroke={INK} strokeWidth={1.5} />
        <text x={-20} y={4} fontSize={11} fill={INK} fontFamily="inherit">
          Invite
        </text>
        <Key x={20} y={0} />
      </Move>

      <Show t={[0.38, 0.95]}>
        <line x1={180} y1={122} x2={300} y2={122} stroke={LINE} strokeDasharray="4 4" />
      </Show>
      {[0.44, 0.6, 0.76].map((s, i) => (
        <Move key={s} path={i % 2 ? 'M300 122 L 180 122' : 'M180 122 L 300 122'} t={[s, s + 0.12]}>
          <Dot />
        </Move>
      ))}
    </>
  );
}

/** 6. Relays pass sealed changes along; an always-on node holds them while a device sleeps */
function SyncScene() {
  return (
    <>
      <Laptop x={20} y={52} />
      <Label x={84} y={170}>
        Laptop
      </Label>

      <g>
        <animate attributeName="opacity" dur={`${LOOP}s`} repeatCount="indefinite" values="1;1;.25;.25;1;1" keyTimes="0;.42;.46;.76;.8;1" />
        <Phone x={408} y={46} />
        <Show t={[0.46, 0.76]}>
          <text x={434} y={100} textAnchor="middle" fontSize={11} fill={MUTED} fontFamily="inherit">
            z z
          </text>
        </Show>
      </g>
      <Label x={434} y={170}>
        Phone
      </Label>

      <rect x={196} y={28} width={88} height={40} rx={8} fill="#fafafa" stroke={INK} strokeWidth={1.5} />
      <text x={240} y={52} textAnchor="middle" fontSize={12} fill={INK} fontFamily="inherit">
        Relay
      </text>
      <rect x={180} y={160} width={120} height={44} rx={8} fill="#fafafa" stroke={INK} strokeWidth={1.5} />
      <text x={240} y={186} textAnchor="middle" fontSize={12} fill={INK} fontFamily="inherit">
        Always-on node
      </text>
      <Label x={240} y={128}>
        Neither can read it
      </Label>

      <path d="M160 90 L196 56 M284 56 L408 90 M160 104 L180 170 M300 170 L408 104" stroke={LINE} strokeDasharray="4 4" fill="none" />

      {/* Awake: through the relay, straight to the phone */}
      <Move path="M150 90 L 240 48 L 420 90" t={[0.06, 0.36]}>
        <Sealed />
      </Move>
      {/* Asleep: the always-on node keeps it, and hands it over on waking */}
      <Move path="M150 104 L 240 170" t={[0.5, 0.62]}>
        <Sealed />
      </Move>
      <Show t={[0.62, 0.8]}>
        <Sealed x={240} y={170} />
      </Show>
      <Move path="M240 170 L 420 104" t={[0.8, 0.92]}>
        <Sealed />
      </Move>
    </>
  );
}

// ─── The section ────────────────────────────────────────────────────

interface Step {
  readonly tab: string;
  readonly title: string;
  readonly body: string;
  readonly Scene: () => ReactNode;
  /** The moment of the loop to show, still, when motion is turned off */
  readonly still: number;
}

const STEPS: ReadonlyArray<Step> = [
  {
    tab: 'Account',
    title: 'Make an account',
    body: 'Weave makes a strong password on your device, and your account comes from it. Save it in your password manager, or use a passkey. There’s no sign-up form, and no company keeps a copy.',
    Scene: AccountScene,
    still: 0.8,
  },
  {
    tab: 'Storage',
    title: 'Keep your data',
    body: 'What you make is saved on your own device first: in the browser, or in a pod, a folder on your computer. It opens instantly and works offline. Private things are encrypted before they’re saved.',
    Scene: StorageScene,
    still: 0.9,
  },
  {
    tab: 'Devices',
    title: 'Add your other devices',
    body: 'Scan a code with your phone, or sign in there with your password. From then on, changes go straight between your devices and show up on both.',
    Scene: DevicesScene,
    still: 0.5,
  },
  {
    tab: 'Apps',
    title: 'Open it in any app',
    body: 'Every Weave app works with the same data. When one wants in, your account home asks you first, then gives the app a signed note: which spaces, and for how long. The app never sees your password, and you can take the note back.',
    Scene: AppsScene,
    still: 0.9,
  },
  {
    tab: 'Sharing',
    title: 'Share a space',
    body: 'Send someone an invite link. The key to the space travels inside the link, so it never passes through a server. Everyone in the space gets every change, and every device checks the space’s rules.',
    Scene: SharingScene,
    still: 0.5,
  },
  {
    tab: 'Sync',
    title: 'Stay in sync',
    body: 'Devices find each other through relays, which pass changes along without being able to read them. An always-on node, your own or a host’s, holds changes while a device sleeps, and can’t read them either.',
    Scene: SyncScene,
    still: 0.7,
  },
];

function prefersReducedMotion() {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

function Stage({ step }: { step: Step }) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const svg = ref.current;
    if (!svg || !prefersReducedMotion()) return;
    svg.pauseAnimations();
    svg.setCurrentTime(step.still * LOOP);
  }, [step]);
  const { Scene } = step;
  return (
    <svg ref={ref} viewBox="0 0 480 240" role="img" aria-label={step.title}>
      <Scene />
    </svg>
  );
}

export function Walkthrough() {
  const [index, setIndex] = useState(0);
  // Plays through on its own until someone picks a step
  const [playing, setPlaying] = useState(() => !prefersReducedMotion());
  const [inView, setInView] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setInView(entry?.isIntersecting ?? false), { threshold: 0.4 });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // On a narrow screen the tabs scroll sideways; keep the current one in sight
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const tabs = tabsRef.current;
    const tab = tabs?.children[index] as HTMLElement | undefined;
    if (!tabs || !tab) return;
    tabs.scrollTo({ left: tab.offsetLeft - (tabs.clientWidth - tab.offsetWidth) / 2, behavior: 'smooth' });
  }, [index]);

  const step = STEPS[index] ?? STEPS[0]!;
  return (
    <div className="walk" ref={ref}>
      <div className="walk-tabs" ref={tabsRef} role="tablist" aria-label="How it works">
        {STEPS.map((s, i) => (
          <button
            key={s.tab}
            type="button"
            role="tab"
            id={`walk-tab-${i}`}
            aria-selected={i === index}
            aria-controls="walk-panel"
            className="walk-tab"
            onClick={() => {
              setIndex(i);
              setPlaying(false);
            }}
          >
            <span className="n">{i + 1}</span>
            {s.tab}
            {playing && i === index && (
              <span
                className="progress"
                style={{ animationDuration: `${DWELL}s`, animationPlayState: inView ? 'running' : 'paused' }}
                onAnimationEnd={() => setIndex((index + 1) % STEPS.length)}
              />
            )}
          </button>
        ))}
      </div>
      <div className="walk-panel" id="walk-panel" role="tabpanel" aria-labelledby={`walk-tab-${index}`}>
        <div className="walk-text">
          <div className="step-label">Step {index + 1} of {STEPS.length}</div>
          <h3>{step.title}</h3>
          <p>{step.body}</p>
        </div>
        <div className="walk-stage">
          {/* A new key per step, so its animation starts from the beginning */}
          <Stage key={index} step={step} />
        </div>
      </div>
    </div>
  );
}
