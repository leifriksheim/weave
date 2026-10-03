import { useState } from 'react';
import { useAccount, useCan, useLive, useNode, useProfiles } from '@weaveprotocol/core/react';
import type { IncludedOf, P2PNode, QueryRecord } from '@weaveprotocol/core';
import { ballot, decision, proposal, type Proposal } from '@weaveprotocol/core/schemas';
import { useAction } from '@weave/app-shared/action';
import { nameOf, peopleFrom, respondingTo } from '../../derive/people';
import { styles, palette, ui } from '../../styles';
import type { AppProps } from './index';
import { OptionBar, OptionCard, OptionsForm } from './options';

/** `std.proposal`, `std.ballot` and `std.decision`: a decision cites the ballots that reach quorum, and every device checks them. */
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
    <div style={{ ...ui.stack, gap: 16, maxWidth: 640 }}>
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
  const { run, error } = useAction();
  const [confirming, setConfirming] = useState<number | null>(null);
  const about = [{ rel: 'about', to: record.key }];
  const { title, options, quorum } = record.body;
  // A ballot counts as first cast: that is the version a decision can cite.
  const ballots = record.included.ballots.filter((b) => b.seq === 0 && b.body.choice < options.length);
  const mine = ballots.find((b) => b.root === me);
  const decided = record.included.decisions.find((d) => d.verified && d.body.outcome < options.length);
  const reached = quorum
    ? options.findIndex((_, i) => ballots.filter((b) => b.body.choice === i).length >= quorum)
    : -1;
  const open = space.writable && !decided;

  return (
    <OptionCard
      record={record}
      verb="proposed"
      badge={!!decided && 'Decided'}
      title={title}
      open="Open this proposal"
      onOpen={() => onOpen(record)}
    >
      <div role="group" aria-label="Options" style={{ ...ui.stack, gap: 6 }}>
        {options.map((option, i) => {
          const these = ballots.filter((b) => b.body.choice === i);
          const chosen = mine?.body.choice === i;
          const won = decided?.body.outcome === i;
          return (
            <OptionBar
              key={i}
              label={`${option}${won ? ' ✓' : ''}`}
              count={quorum ? `${these.length} of ${quorum}` : these.length}
              share={quorum ? Math.min(1, these.length / quorum) : 0}
              chosen={chosen}
              strong={chosen || won}
              clickable={open && !mine}
              voters={these.map((b) => nameOf(b.root, people))}
              onClick={() => setConfirming(i)}
            />
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
              const choice = confirming;
              void run(() =>
                node.records.put(
                  space.id,
                  ballot,
                  { choice, ...respondingTo(record.root, me) },
                  { links: about },
                ),
              );
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
        {!decided && space.writable && reached >= 0 && (
          <button
            onClick={() =>
              void run(async () =>
                node.records.put(
                  space.id,
                  decision,
                  {
                    outcome: reached,
                    proposal: await firstVersion(node, space.id, record),
                    ballots: ballots.filter((b) => b.body.choice === reached).map((b) => b.version),
                  },
                  { links: about },
                ),
              )
            }
            data-variant="primary"
            style={{ ...styles.addButton, height: 28 }}
          >
            Record the decision
          </button>
        )}
      </footer>
      {error && <p style={{ fontSize: 13, color: palette.accent.danger }}>{error}</p>}
    </OptionCard>
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
  const [quorum, setQuorum] = useState(2);
  return (
    <OptionsForm
      initialOptions={['Yes', 'No']}
      placeholder="What should the space decide?"
      label="Proposal"
      submit="Propose"
      submitting="Proposing…"
      valid={quorum >= 1}
      onSubmit={(title, options) => onPropose(title, options, quorum)}
      onCancel={onCancel}
      extra={
        <label
          style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: palette.ink.body }}
        >
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
      }
    />
  );
}
