import { useMemo, useState } from 'react';
import { useNode } from '@weaveprotocol/core/react';
import { Avatar } from '@weave/app-shared/Avatar';
import { Modal } from '@weave/app-shared/Modal';
import type { Assembly, MyDelegation, TopicView } from './model';
import { EVERYTHING, delegation } from './schema';
import { follow, type DelegationEdge, type Next } from './tally';
import { PartyChip, PartyMark, PathView, Problem, TopicChip, Who, decidesText } from './ui';
import { useAction } from '@weave/app-shared/action';
import { palette } from './styles';

/** Where someone's vote would go on a topic if nobody voted: the chain of trust alone */
function chainFor(
  a: Assembly,
  did: string,
  topic: string | null,
  delegations: ReadonlyArray<DelegationEdge> = a.delegations,
): Next {
  return follow({
    me: did,
    topic,
    votes: new Map(),
    delegations,
    parties: new Map(),
    voters: new Set(a.members.map((m) => m.did)),
  });
}

/** Whether trusting someone with a topic would bring the chain back round to you */
function makesLoop(a: Assembly, topic: string, to: string): boolean {
  const edges = [
    ...a.delegations.filter((d) => !(d.from === a.me && d.topic === topic)),
    { from: a.me, kind: 'person' as const, to, topic },
  ];
  const next = chainFor(a, a.me, topic === EVERYTHING ? null : topic, edges);
  return next.kind === 'wait' && next.how === 'loop';
}

export function Delegations({ a, writable }: { a: Assembly; writable: boolean }) {
  const [picking, setPicking] = useState<{ topic: string; label: string } | null>(null);
  const rows: ReadonlyArray<{ key: string; topic: TopicView | null }> = [
    { key: EVERYTHING, topic: null },
    ...a.topics.map((t) => ({ key: t.key, topic: t })),
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <section className="lq-rise" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <h2 style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.04em', color: palette.ink.strong }}>
          Who votes when you don’t
        </h2>
        <p className="lq-muted" style={{ fontSize: 14.5, lineHeight: 1.55, maxWidth: 600 }}>
          Trust someone with a topic. When they vote on a proposal you haven’t, your device casts the same
          vote for you, signed by you. Vote first and yours counts instead. Votes are final, but you can move
          or take back your trust at any time, for proposals still to come.
        </p>
      </section>

      <section className="lq-card">
        {rows.map(({ key, topic }) => (
          <TrustRow
            key={key}
            a={a}
            topicKey={key}
            topic={topic}
            writable={writable}
            onPick={() => setPicking({ topic: key, label: topic?.name ?? 'everything' })}
          />
        ))}
      </section>

      <TrustedBy a={a} />

      {picking && (
        <Picker
          a={a}
          topic={picking.topic}
          label={picking.label}
          current={a.mine.find((d) => d.topic === picking.topic) ?? null}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  );
}

function TrustRow({
  a,
  topicKey,
  topic,
  writable,
  onPick,
}: {
  a: Assembly;
  topicKey: string;
  topic: TopicView | null;
  writable: boolean;
  onPick: () => void;
}) {
  const node = useNode();
  const action = useAction();
  const mine = a.mine.find((d) => d.topic === topicKey) ?? null;
  const fallback = topic ? (a.mine.find((d) => d.topic === EVERYTHING) ?? null) : null;
  const outcome = chainFor(a, a.me, topic ? topicKey : null);

  return (
    <div className="lq-row" style={{ alignItems: 'flex-start', padding: '16px 18px', flexWrap: 'wrap' }}>
      <div style={{ width: 150, flexShrink: 0, paddingTop: 2 }}>
        {topic ? (
          <TopicChip topic={topic} />
        ) : (
          <span
            className="lq-chip"
            style={{ fontWeight: 600, borderColor: palette.ink.strong, color: palette.ink.strong }}
          >
            Everything
          </span>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 200, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {mine ? (
          <Target a={a} d={mine} />
        ) : fallback ? (
          <span
            className="lq-muted"
            style={{ fontSize: 13.5, display: 'inline-flex', gap: 6, alignItems: 'center' }}
          >
            Same as everything: <Target a={a} d={fallback} />
          </span>
        ) : (
          <span className="lq-muted" style={{ fontSize: 13.5 }}>
            {topic ? 'Nobody. You vote on this yourself.' : 'Nobody. You vote on everything yourself.'}
          </span>
        )}
        {(mine || fallback) && <ChainNote a={a} next={outcome} />}
        <Problem>{action.error}</Problem>
      </div>
      {writable && (
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="lq-btn" data-variant="quiet" data-size="sm" onClick={onPick}>
            {mine ? 'Change' : 'Trust someone'}
          </button>
          {mine && (
            <button
              className="lq-btn"
              data-variant="ghost"
              data-size="sm"
              disabled={action.busy}
              onClick={() => void action.run(() => node.records.delete(a.spaceId, mine.key))}
            >
              Stop
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Target({ a, d }: { a: Assembly; d: MyDelegation }) {
  if (d.kind === 'party') {
    const party = a.partyOf(d.to);
    return party ? <PartyChip party={party} /> : <span className="lq-faint">A party that’s gone</span>;
  }
  const member = a.members.some((m) => m.did === d.to);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 500 }}>
      <Who did={d.to} a={a} size={22} />
      {!member && (
        <span className="lq-chip" style={{ color: palette.accent.danger }}>
          left the assembly
        </span>
      )}
    </span>
  );
}

/** Where the chain of trust ends, when it goes past the first step, or goes nowhere */
function ChainNote({ a, next }: { a: Assembly; next: Next }) {
  if (next.kind !== 'wait') return null;
  if (next.how === 'loop')
    return (
      <div className="lq-note" data-tone="warn" style={{ fontSize: 12.5 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <PathView path={next.path} a={a} from={a.me} />
          <span>
            This comes back round to you. Unless someone on it votes themselves, nobody does: nothing is ever
            copied round a loop.
          </span>
        </div>
      </div>
    );
  if (next.path.length < 2) return null;
  return (
    <div className="lq-muted" style={{ fontSize: 12.5, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span>When they follow someone too, it goes on:</span>
      <PathView path={next.path} a={a} from={a.me} />
    </div>
  );
}

/** Whose votes come to you, topic by topic */
function TrustedBy({ a }: { a: Assembly }) {
  const rows = useMemo(() => {
    const topics: ReadonlyArray<{ key: string; topic: TopicView | null }> = [
      { key: EVERYTHING, topic: null },
      ...a.topics.map((t) => ({ key: t.key, topic: t })),
    ];
    return topics
      .map(({ key, topic }) => {
        const outcomes = a.members.map((m) => [m.did, chainFor(a, m.did, topic ? key : null)] as const);
        const through = outcomes.filter(
          ([did, o]) =>
            did !== a.me && o.kind === 'wait' && o.path.some((s) => s.kind === 'person' && s.did === a.me),
        );
        const direct = through.filter(
          ([, o]) => o.kind === 'wait' && o.path[0]?.kind === 'person' && o.path[0].did === a.me,
        );
        return { key, topic, through: through.length, direct: direct.map(([did]) => did) };
      })
      .filter((row, _, all) => {
        if (row.through === 0) return false;
        // A topic that comes to you just as everything does needs no row of its own.
        const everything = all[0];
        return (
          !row.topic ||
          !everything ||
          row.through !== everything.through ||
          row.direct.join() !== everything.direct.join()
        );
      });
  }, [a]);

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p className="lq-section-title">Who trusts you</p>
      {rows.length === 0 ? (
        <p className="lq-faint" style={{ fontSize: 13.5 }}>
          Nobody’s vote comes to you yet. When someone trusts you with a topic, it shows here.
        </p>
      ) : (
        <div className="lq-card">
          {rows.map((row) => (
            <div key={row.key} className="lq-row" style={{ flexWrap: 'wrap' }}>
              <div style={{ width: 150, flexShrink: 0 }}>
                {row.topic ? (
                  <TopicChip topic={row.topic} />
                ) : (
                  <span className="lq-chip">{rows.length > 1 ? 'Everything else' : 'Everything'}</span>
                )}
              </div>
              <span className="lq-stack">
                {row.direct.slice(0, 6).map((did) => (
                  <Avatar key={did} did={did} size={22} />
                ))}
              </span>
              <span className="lq-muted lq-num" style={{ fontSize: 13 }}>
                {row.through} {row.through === 1 ? 'vote follows' : 'votes follow'} yours when they don’t vote
                {row.through > row.direct.length
                  ? `, ${row.direct.length} from people who trust you directly`
                  : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Picking who to trust with a topic: a person or a party */
function Picker({
  a,
  topic,
  label,
  current,
  onClose,
}: {
  a: Assembly;
  topic: string;
  label: string;
  current: MyDelegation | null;
  onClose: () => void;
}) {
  const node = useNode();
  const [kind, setKind] = useState<'person' | 'party'>(current?.kind ?? 'person');
  const [search, setSearch] = useState('');
  const action = useAction();
  const q = search.trim().toLowerCase();
  const trustCount = (did: string) =>
    a.delegations.filter((d) => d.kind === 'person' && d.to === did && d.topic === topic).length;
  const people = a.members
    .filter((m) => m.did !== a.me)
    .filter((m) => !q || a.name(m.did).toLowerCase().includes(q))
    .sort((x, y) => trustCount(y.did) - trustCount(x.did));
  const parties = a.parties.filter((p) => !q || p.name.toLowerCase().includes(q));

  const pick = (to: string) =>
    void action.run(async () => {
      await node.records.put(a.spaceId, delegation, { kind, to, topic });
      onClose();
    });

  return (
    <Modal title={`Who do you trust with ${label}?`} onClose={onClose} width={480}>
      <div
        role="tablist"
        style={{ display: 'flex', padding: 3, gap: 3, background: palette.surface.sunken, borderRadius: 8 }}
      >
        {(['person', 'party'] as const).map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={kind === k}
            onClick={() => setKind(k)}
            style={{
              flex: 1,
              padding: '7px 10px',
              borderRadius: 6,
              border: 'none',
              fontSize: 13,
              fontWeight: kind === k ? 600 : 500,
              background: kind === k ? palette.surface.card : 'none',
              color: kind === k ? palette.ink.strong : palette.ink.muted,
              boxShadow: kind === k ? '0 1px 2px rgba(15,17,21,.08)' : 'none',
            }}
          >
            {k === 'person' ? `A person (${a.members.length - 1})` : `A party (${a.parties.length})`}
          </button>
        ))}
      </div>
      <input
        className="lq-input"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder={kind === 'person' ? 'Search people' : 'Search parties'}
        aria-label="Search"
      />
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          maxHeight: 340,
          overflowY: 'auto',
          margin: '0 -6px',
        }}
      >
        {kind === 'person' &&
          people.map((m) => {
            const n = trustCount(m.did);
            const theirParties = a.parties.filter((p) => p.members.has(m.did));
            const loops = makesLoop(a, topic, m.did);
            return (
              <button
                key={m.did}
                className="lq-pick"
                aria-pressed={current?.kind === 'person' && current.to === m.did}
                disabled={action.busy}
                onClick={() => pick(m.did)}
              >
                <Avatar did={m.did} size={32} />
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontWeight: 500 }}>{a.name(m.did)}</span>
                  <span className="lq-faint" style={{ fontSize: 12 }}>
                    {[
                      loops ? 'trusts you back: a loop' : '',
                      theirParties.map((p) => p.name).join(', '),
                      n ? `trusted by ${n} on ${label}` : '',
                    ]
                      .filter(Boolean)
                      .join(' · ') || m.role}
                  </span>
                </span>
              </button>
            );
          })}
        {kind === 'party' &&
          parties.map((p) => (
            <button
              key={p.key}
              className="lq-pick"
              aria-pressed={current?.kind === 'party' && current.to === p.key}
              disabled={action.busy}
              onClick={() => pick(p.key)}
            >
              <PartyMark party={p} size={32} />
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontWeight: 500 }}>{p.name}</span>
                <span
                  className="lq-faint"
                  style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {decidesText(a, p)}
                  {p.platform ? ` · ${p.platform}` : ''}
                </span>
              </span>
            </button>
          ))}
        {kind === 'person' && people.length === 0 && (
          <p className="lq-faint" style={{ padding: 10, fontSize: 13 }}>
            {q ? 'Nobody by that name.' : 'Nobody else is here yet. Invite someone first.'}
          </p>
        )}
        {kind === 'party' && parties.length === 0 && (
          <p className="lq-faint" style={{ padding: 10, fontSize: 13 }}>
            {q ? 'No party by that name.' : 'No parties yet. Anyone can start one under People.'}
          </p>
        )}
      </div>
      {kind === 'party' && (
        <p className="lq-faint" style={{ fontSize: 12, lineHeight: 1.5 }}>
          A party takes a position once enough of its members vote the same way themselves, or its
          representative votes, as the party decides. Your device then casts that vote for you.
        </p>
      )}
      <Problem>{action.error}</Problem>
    </Modal>
  );
}
