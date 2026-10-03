import { useState } from 'react';
import { useConnection } from '@weaveprotocol/core/react';
import { palette, tone } from './styles';

/** Liquid's mark: two votes flowing into a third */
export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
      <svg width="24" height="24" viewBox="0 0 32 32" aria-hidden>
        <rect width="32" height="32" rx="8" fill="#000" />
        <circle cx="10" cy="11" r="3" fill="#fff" />
        <circle cx="22" cy="11" r="3" fill="#fff" />
        <circle cx="16" cy="22" r="4" fill="#fff" />
        <path
          d="M11.5 13.5 14.5 19M20.5 13.5 17.5 19"
          stroke="#fff"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
      {!compact && (
        <span style={{ fontWeight: 600, fontSize: 17, letterSpacing: '-0.04em', color: palette.ink.strong }}>
          Liquid
        </span>
      )}
    </span>
  );
}

/**
 * Before connecting: what this is, in one sentence and one drawing, and the
 * button that opens the person's account home. Nothing about the account is
 * typed here.
 */
export function Welcome() {
  const { connection, state } = useConnection();
  const [own, setOwn] = useState<string | null>(null);
  const expired = state.status === 'expired';
  const waiting = state.status === 'connecting' || state.status === 'starting';
  const home = new URL(state.home).host;

  return (
    <div className="lq-shell">
      <header className="lq-header" style={{ background: 'transparent', borderBottomColor: 'transparent' }}>
        <div className="lq-header-inner lq-bar">
          <Logo />
          <span style={{ flex: 1 }} />
          <a
            href="https://github.com/leifriksheim/weave"
            className="lq-muted"
            style={{ fontSize: 13, textDecoration: 'none' }}
          >
            Built on Weave
          </a>
        </div>
      </header>
      <main className="lq-main" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div
          className="lq-rise"
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            textAlign: 'center',
            gap: 18,
            paddingTop: 40,
          }}
        >
          <span className="lq-chip" style={{ height: 28, padding: '0 12px' }}>
            <span className="lq-dot" style={{ background: tone.for }} />
            Liquid democracy for any group
          </span>
          <h1
            style={{
              fontSize: 'clamp(36px, 7vw, 56px)',
              lineHeight: 1.02,
              letterSpacing: '-0.055em',
              fontWeight: 600,
              color: palette.ink.strong,
              maxWidth: 640,
            }}
          >
            {expired ? 'Welcome back.' : 'Decide together, or trust someone who knows.'}
          </h1>
          <p style={{ fontSize: 17, lineHeight: 1.55, color: palette.ink.muted, maxWidth: 520 }}>
            {expired
              ? `Liquid’s access to ${state.grant?.name ?? 'your account'} ran out. Your account home will ask you to allow it again.`
              : 'Vote on anything yourself. When you don’t, your vote goes to the person or party you trust with that topic. Change your mind whenever you like.'}
          </p>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 10,
              marginTop: 6,
              width: '100%',
              maxWidth: 340,
            }}
          >
            {own === null ? (
              <>
                <button
                  className="lq-btn"
                  data-variant="primary"
                  data-size="lg"
                  style={{ width: '100%' }}
                  disabled={waiting}
                  onClick={() => void connection.connect()}
                >
                  {state.status === 'connecting' ? 'Waiting for your account home…' : 'Connect with Weave'}
                </button>
                <p className="lq-faint" style={{ fontSize: 12.5, lineHeight: 1.55 }}>
                  Opens <strong style={{ color: palette.ink.body }}>{home}</strong> in a small window. Liquid
                  gets a note signed by your account, never your password.{' '}
                  <button className="lq-link" style={{ fontSize: 12.5 }} onClick={() => setOwn('')}>
                    Use your own home
                  </button>
                </p>
              </>
            ) : (
              <form
                style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}
                onSubmit={(event) => {
                  event.preventDefault();
                  void connection.connect(own);
                }}
              >
                <input
                  className="lq-input"
                  value={own}
                  onChange={(event) => setOwn(event.target.value)}
                  placeholder="home.example.com"
                  aria-label="Your account home’s address"
                  autoFocus
                  spellCheck={false}
                  autoCapitalize="off"
                />
                <button className="lq-btn" data-variant="primary" disabled={waiting || !own.trim()}>
                  Connect
                </button>
                <button
                  type="button"
                  className="lq-link lq-muted"
                  style={{ fontSize: 12.5 }}
                  onClick={() => setOwn(null)}
                >
                  Use {home} instead
                </button>
              </form>
            )}
            {state.error && (
              <p role="alert" style={{ fontSize: 13, color: tone.against }}>
                {state.error}
              </p>
            )}
          </div>
        </div>

        <FlowArt />

        <div className="lq-grid" style={{ width: '100%', marginTop: 8 }}>
          {[
            [
              'Vote directly',
              'Vote before your device follows someone, and your own vote is the one that counts.',
            ],
            [
              'Delegate by topic',
              'Trust a neighbour with housing and a party with the budget. Each topic on its own.',
            ],
            [
              'Settled for good',
              'Once more than half the voters agree, it’s decided on every device, and no late vote changes it.',
            ],
          ].map(([title, text]) => (
            <div key={title} className="lq-card" style={{ padding: 18 }}>
              <p className="lq-section-title" style={{ fontSize: 14, marginBottom: 6 }}>
                {title}
              </p>
              <p className="lq-muted" style={{ fontSize: 13.5, lineHeight: 1.55 }}>
                {text}
              </p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}

/** Five people: two vote, one trusts a neighbour, two trust a party, and it all lands in one count */
function FlowArt() {
  const person = (x: number, y: number, fill: string, key: string) => (
    <g key={key}>
      <circle cx={x} cy={y} r="15" fill={fill} />
      <circle cx={x} cy={y - 4} r="5" fill="#fff" opacity=".9" />
      <path d={`M${x - 8} ${y + 9} a8 7 0 0 1 16 0`} fill="#fff" opacity=".9" />
    </g>
  );
  const flow = (d: string, key: string, dashed = false) => (
    <path
      key={key}
      d={d}
      fill="none"
      stroke={palette.ink.faint}
      strokeWidth="1.5"
      strokeDasharray={dashed ? '4 4' : undefined}
      markerEnd="url(#lq-arrow)"
    />
  );
  return (
    <svg
      viewBox="0 0 440 210"
      className="lq-hero-art"
      style={{ margin: '48px 0 40px' }}
      role="img"
      aria-label="Votes flowing through delegations into one count"
    >
      <defs>
        <marker
          id="lq-arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M0 0 8 4 0 8z" fill={palette.ink.faint} />
        </marker>
      </defs>
      {flow('M60 44 C 90 44, 110 64, 128 80', 'a', true)}
      {flow('M60 150 C 150 170, 250 150, 300 128', 'b')}
      {flow('M160 102 C 200 108, 250 110, 292 112', 'c')}
      {flow('M250 34 C 260 50, 262 60, 262 64', 'd', true)}
      {flow('M330 34 C 316 50, 300 58, 292 64', 'e', true)}
      {flow('M262 96 C 270 102, 280 106, 292 108', 'f')}
      {person(44, 44, '#7c3aed', 'p1')}
      {person(145, 96, '#0ea5e9', 'p2')}
      {person(44, 150, '#f59e0b', 'p3')}
      {person(250, 22, '#ec4899', 'p4')}
      {person(334, 22, '#14b8a6', 'p5')}
      <rect x="236" y="66" width="52" height="30" rx="8" fill={palette.ink.strong} />
      <text
        x="262"
        y="86"
        textAnchor="middle"
        fontSize="12"
        fontWeight="700"
        fill="#fff"
        fontFamily="Geist, sans-serif"
      >
        Party
      </text>
      <rect x="296" y="88" width="120" height="58" rx="12" fill="#fff" stroke={palette.surface.line} />
      <rect x="310" y="104" width="54" height="7" rx="3.5" fill={tone.for} />
      <rect x="364" y="104" width="22" height="7" rx="3.5" fill={tone.against} />
      <rect x="386" y="104" width="16" height="7" rx="3.5" fill={tone.track} />
      <text x="310" y="132" fontSize="11" fill={palette.ink.muted} fontFamily="Geist, sans-serif">
        5 of 5 counted
      </text>
      <text x="92" y="36" fontSize="10.5" fill={palette.ink.faint} fontFamily="Geist, sans-serif">
        trusts on housing
      </text>
    </svg>
  );
}
