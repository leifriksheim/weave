import { useState } from 'react';
import { useAccount, useCan, useLive, useNode, useProfiles } from '@weaveprotocol/core/react';
import type { IncludedOf, P2PNode, QueryRecord } from '@weaveprotocol/core';
import { ballot, decision, proposal, type Proposal } from '@weaveprotocol/core/schemas';
import { nameOf, peopleFrom, respondingTo, type People } from '../../derive/people';
import { ago } from '../../derive/time';
import { Avatar } from '@weave/app-shared/Avatar';
import { styles, palette } from '../../styles';
import type { AppProps } from './index';
import { Person } from '../Person';

const MAX_OPTIONS = 10;

/**
 * `std.proposal`, `std.ballot` and `std.decision`: put something to the
 * space, and decide it once enough people agree. A ballot is final. A
 * decision is proven, not declared: it cites the proposal and the ballots
 * that reach its quorum, and every device checks them before it counts
 * (`std.decision`'s check). Nobody has to be trusted to count.
 */
export function Decisions({ space, onOpen }: AppProps) {
  const node = useNode();
  const mayPropose = useCan(space.id, 'create', proposal.name);
  const [proposing, setProposing] = useState(false);

  const proposals = useLive(
    space.id,
    async () =>
      (
        await node.records.query(space.id, {
          collection: proposal,
          sort: { '@createdAt': 'desc' },
          include: withOutcome,
        })
      ).records,
    [],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 640 }}>
      {mayPropose &&
        (proposing ? (
          <Propose
            onCancel={() => setProposing(false)}
            onPropose={async (title, options, quorum) => {
              await node.records.put(space.id, proposal, { title, options, quorum });
              setProposing(false);
            }}
          />
        ) : (
          <button onClick={() => setProposing(true)} data-variant="primary" style={styles.addButton}>
            New proposal
          </button>
        ))}
      {proposals?.length === 0 && !proposing && (
        <div style={styles.emptyState}>
          Nothing to decide yet.{mayPropose ? ' Put something to the space.' : ''}
        </div>
      )}
      {proposals?.map((p) => (
        <ProposalView key={p.key} space={space} record={p} onOpen={onOpen} />
      ))}
    </div>
  );
}

const withOutcome = {
  ballots: { rel: 'about', from: ballot },
  decisions: { rel: 'about', from: decision },
} as const;

type ProposalWithOutcome = QueryRecord<Proposal, IncludedOf<typeof withOutcome>>;

/** The id of a record's first version: what a decision cites, since that is what every device holds whole */
async function firstVersion(node: P2PNode, spaceId: string, record: ProposalWithOutcome): Promise<string> {
  if (record.seq === 0) return record.version;
  const history = await node.records.history(spaceId, record.key);
  const first = history.find((version) => version.seq === 0);
  if (!first) throw new Error('The proposal’s first version isn’t on this device yet');
  return first.version;
}

function ProposalView({
  space,
  record,
  onOpen,
}: {
  space: AppProps['space'];
  record: ProposalWithOutcome;
  onOpen: AppProps['onOpen'];
}) {
  const node = useNode();
  const { did: me } = useAccount();
  const people = peopleFrom(useProfiles(space.id));
  const [problem, setProblem] = useState<string | null>(null);
  const about = [{ rel: 'about', to: record.key }];

  const attempt = (work: () => Promise<unknown>) => {
    setProblem(null);
    work().catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error)));
  };

  return (
    <ProposalCard
      record={record}
      me={me}
      people={people}
      writable={space.writable}
      problem={problem}
      onOpen={() => onOpen(record)}
      onCast={(choice) =>
        attempt(() =>
          node.records.put(space.id, ballot, { choice, ...respondingTo(record.root, me) }, { links: about }),
        )
      }
      onDecide={(outcome, ballots) =>
        attempt(async () =>
          node.records.put(
            space.id,
            decision,
            { outcome, proposal: await firstVersion(node, space.id, record), ballots },
            { links: about },
          ),
        )
      }
    />
  );
}

function ProposalCard({
  record,
  me,
  people,
  writable,
  problem,
  onOpen,
  onCast,
  onDecide,
}: {
  record: ProposalWithOutcome;
  me: string;
  people: People;
  writable: boolean;
  problem: string | null;
  onOpen: () => void;
  onCast: (choice: number) => void;
  onDecide: (outcome: number, ballots: string[]) => void;
}) {
  const { title, options, quorum } = record.body;
  // A ballot counts as first cast: that is the version a decision can cite.
  const ballots = record.included.ballots.filter((b) => b.seq === 0 && b.body.choice < options.length);
  const mine = ballots.find((b) => b.root === me);
  const decided = record.included.decisions.find((d) => d.verified && d.body.outcome < options.length);
  const reached = quorum
    ? options.findIndex((_, i) => ballots.filter((b) => b.body.choice === i).length >= quorum)
    : -1;
  const [confirming, setConfirming] = useState<number | null>(null);
  const open = writable && !decided;

  return (
    <article
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 16,
        border: `1px solid ${palette.surface.line}`,
        borderRadius: 10,
      }}
    >
      <header style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: palette.ink.faint }}
        >
          <Avatar did={record.createdBy ?? record.author} size={18} />
          <span>
            <Person did={record.createdBy} /> proposed · {ago(record.createdAt)}
          </span>
          {decided && <span style={{ ...styles.badge, marginLeft: 'auto' }}>Decided</span>}
        </div>
        <button
          onClick={onOpen}
          title="Open this proposal"
          style={{
            border: 'none',
            background: 'none',
            padding: 0,
            font: 'inherit',
            fontSize: 16,
            fontWeight: 600,
            color: palette.ink.strong,
            textAlign: 'left',
            wordBreak: 'break-word',
          }}
        >
          {title}
        </button>
      </header>

      <div role="group" aria-label="Options" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {options.map((option, i) => {
          const these = ballots.filter((b) => b.body.choice === i);
          const share = quorum ? Math.min(1, these.length / quorum) : 0;
          const chosen = mine?.body.choice === i;
          const won = decided?.body.outcome === i;
          return (
            <button
              key={i}
              onClick={() => setConfirming(i)}
              disabled={!open || !!mine}
              aria-pressed={chosen}
              title={these.length ? these.map((b) => nameOf(b.root, people)).join(', ') : undefined}
              style={{
                position: 'relative',
                overflow: 'hidden',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                height: 40,
                padding: '0 12px',
                border: `1px solid ${chosen || won ? palette.ink.strong : palette.surface.line}`,
                borderRadius: 8,
                background: palette.surface.card,
                font: 'inherit',
                fontSize: 14,
                color: palette.ink.body,
                textAlign: 'left',
                opacity: 1,
                cursor: open && !mine ? 'pointer' : 'default',
              }}
            >
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: `${share * 100}%`,
                  background: chosen || won ? palette.accent.soft : palette.surface.sunken,
                  transition: 'width .3s ease',
                }}
              />
              <span
                style={{
                  position: 'relative',
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontWeight: chosen || won ? 600 : 400,
                }}
              >
                {option}
                {won ? ' ✓' : ''}
              </span>
              <span
                style={{
                  position: 'relative',
                  fontSize: 12,
                  color: palette.ink.muted,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {quorum ? `${these.length} of ${quorum}` : these.length}
              </span>
            </button>
          );
        })}
      </div>

      {confirming !== null && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13 }}>
          <span style={{ flex: 1, color: palette.ink.body }}>
            Cast your ballot for “{options[confirming]}”? It can’t be changed afterwards.
          </span>
          <button onClick={() => setConfirming(null)} data-variant="quiet" style={styles.smallButton}>
            Cancel
          </button>
          <button
            onClick={() => {
              onCast(confirming);
              setConfirming(null);
            }}
            data-variant="primary"
            style={{ ...styles.addButton, height: 32 }}
          >
            Cast ballot
          </button>
        </div>
      )}

      <footer
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          fontSize: 12,
          color: palette.ink.faint,
        }}
      >
        <span style={{ flex: 1 }}>
          {decided
            ? `Decided by ${decided.body.ballots.length} ballots, checked by every device`
            : !quorum
              ? 'No quorum set, so it can’t be decided here'
              : mine
                ? `You chose “${options[mine.body.choice]}”. ${quorum} ballots for one option decide it.`
                : `${quorum} ballots for one option decide it. Ballots are final.`}
        </span>
        {!decided && writable && reached >= 0 && (
          <button
            onClick={() =>
              onDecide(
                reached,
                ballots.filter((b) => b.body.choice === reached).map((b) => b.version),
              )
            }
            data-variant="primary"
            style={{ ...styles.addButton, height: 28 }}
          >
            Record the decision
          </button>
        )}
      </footer>
      {problem && <p style={{ fontSize: 13, color: palette.accent.danger }}>{problem}</p>}
    </article>
  );
}

/** A title, its options, and how many ballots for one option decide it */
function Propose({
  onPropose,
  onCancel,
}: {
  onPropose: (title: string, options: string[], quorum: number) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [options, setOptions] = useState(['Yes', 'No']);
  const [quorum, setQuorum] = useState(2);
  const [busy, setBusy] = useState(false);
  const filled = options.map((o) => o.trim()).filter(Boolean);
  const ready = title.trim() && filled.length >= 2 && new Set(filled).size === filled.length && quorum >= 1;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        setBusy(true);
        void onPropose(title.trim(), filled, quorum).finally(() => setBusy(false));
      }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 16,
        border: `1px solid ${palette.surface.line}`,
        borderRadius: 10,
      }}
    >
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="What should the space decide?"
        aria-label="Proposal"
        style={styles.input}
      />
      {options.map((option, i) => (
        <input
          key={i}
          value={option}
          onChange={(e) => setOptions((was) => was.map((o, j) => (j === i ? e.target.value : o)))}
          placeholder={`Option ${i + 1}`}
          aria-label={`Option ${i + 1}`}
          style={styles.input}
        />
      ))}
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: palette.ink.body }}>
        Decided by
        <input
          type="number"
          min={1}
          max={10000}
          value={quorum}
          onChange={(e) => setQuorum(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
          aria-label="Quorum"
          style={{ ...styles.input, width: 72 }}
        />
        ballots for one option
      </label>
      {filled.length !== new Set(filled).size && (
        <p style={{ fontSize: 13, color: palette.accent.danger }}>Two options are the same.</p>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {options.length < MAX_OPTIONS && (
          <button
            type="button"
            onClick={() => setOptions((was) => [...was, ''])}
            data-variant="quiet"
            style={styles.smallButton}
          >
            + Add option
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button type="button" onClick={onCancel} data-variant="quiet" style={styles.smallButton}>
          Cancel
        </button>
        <button
          type="submit"
          disabled={!ready || busy}
          data-variant="primary"
          style={{ ...styles.addButton, height: 32 }}
        >
          {busy ? 'Proposing…' : 'Propose'}
        </button>
      </div>
    </form>
  );
}
