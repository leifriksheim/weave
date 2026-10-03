import { useEffect, useMemo, useState } from 'react';
import { recordHolds, type NodeCollection, type NodeRecord, type SpaceSummary } from '@weaveprotocol/core';
import { useAccount, useNode } from '@weaveprotocol/core/react';
import { Modal } from '@weave/app-shared/Modal';
import { clauseFields, clausesWords, subscriptionOf, whereOf, type Clause } from '../../derive/conditions';
import { collectionLabel, recordLabel } from '../../derive/schema-ui';
import { nameOf } from '../../derive/people';
import { ago } from '../../derive/time';
import { useAsk } from '../../notifications';
import { usePeopleHere } from '../Person';
import { styles, palette } from '../../styles';
import { ClauseList, Pill, Sentence, Step, card, previewBox } from './parts';

type Who = 'others' | 'anyone';
type Where = 'space' | 'all';

/** How many of the newest records the preview looks through */
const LOOK_BACK = 50;

/** "Notify me when…" picked from a collection's fields, showing what it would have caught lately before the home asks to confirm */
export function WatchBuilder({
  space,
  collections,
  prefer = [],
  onClose,
}: {
  space: SpaceSummary;
  collections: ReadonlyArray<NodeCollection>;
  /** Collections to offer first: the open app's */
  prefer?: ReadonlyArray<string>;
  onClose: () => void;
}) {
  const node = useNode();
  const { did } = useAccount();
  const here = usePeopleHere();
  const people = here?.people ?? new Map();
  const { ask, asking, error, permission } = useAsk();

  const offered = useMemo(() => {
    const usable = collections.filter(
      (c) => c.schema !== null && c.version !== null && !c.name.startsWith('app.rule'),
    );
    const first = usable.filter((c) => prefer.includes(c.name));
    return [...first, ...usable.filter((c) => !prefer.includes(c.name))];
  }, [collections, prefer]);

  const [collection, setCollection] = useState(offered[0]?.name ?? '');
  const [clauses, setClauses] = useState<ReadonlyArray<Clause>>([]);
  const [who, setWho] = useState<Who>('others');
  const [where, setWhere] = useState<Where>('space');
  const [label, setLabel] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const chosen = offered.find((c) => c.name === collection);
  const fields = useMemo(() => (chosen ? clauseFields(chosen) : []), [chosen]);
  const thing = chosen ? collectionLabel(chosen) : '';
  const words = clausesWords(clauses, fields, (d) => nameOf(d, people));
  const autoLabel =
    `${thing ? `New ${thing.toLowerCase()}` : 'Something new'}${words ? `: ${words}` : ''}`.slice(0, 120);
  const shown = label ?? autoLabel;

  // What it would have caught lately, in this space.
  const looking = JSON.stringify([collection, clauses, who]);
  const [found, setFound] = useState<{ for: string; matched: NodeRecord[]; looked: number } | null>(null);
  const preview = found?.for === looking ? found : null;
  useEffect(() => {
    if (!collection) return;
    let live = true;
    const condition = whereOf(clauses, did);
    void node.records
      .list(space.id, { collection, newestFirst: true, limit: LOOK_BACK })
      .then(async (records) => {
        const matched: NodeRecord[] = [];
        for (const record of records) {
          if (!record.verified || record.body === null) continue;
          if (who === 'others' && record.createdBy === did) continue;
          if (
            condition !== undefined &&
            !(await recordHolds(condition, { ...record, author: record.createdBy }))
          )
            continue;
          matched.push(record);
        }
        if (live) setFound({ for: looking, matched, looked: records.length });
      })
      .catch(() => live && setFound({ for: looking, matched: [], looked: 0 }));
    return () => {
      live = false;
    };
  }, [node, space.id, collection, clauses, who, did, looking]);

  const submit = () => {
    if (!chosen) return;
    const { topic, where: condition } = subscriptionOf(clauses, fields, did);
    void ask([
      {
        label: shown.trim() || autoLabel,
        collection,
        others: who === 'others',
        ...(where === 'space' ? { spaces: [space.id] } : {}),
        ...(topic ? { topic } : {}),
        ...(condition !== undefined ? { where: condition } : {}),
      },
    ]).then((kept) => kept && setDone(true));
  };

  if (done)
    return (
      <Modal title="You'll be notified" onClose={onClose} width={560}>
        <p style={{ ...styles.hint, marginBottom: 0 }}>
          “{shown}” is on. This app lets you know while it's open, in a tab or installed. You can pause or
          remove it any time in your account.
        </p>
        <button onClick={onClose} data-variant="primary" style={styles.button}>
          Done
        </button>
      </Modal>
    );

  return (
    <Modal title="Notify me when…" onClose={onClose} width={620}>
      <p style={{ fontSize: 14, color: palette.ink.muted, lineHeight: 1.5, marginTop: -6 }}>
        Pick what's worth hearing about. Your account asks you to confirm it.
      </p>

      {offered.length === 0 ? (
        <p style={styles.emptyState}>This space has nothing to be notified about yet.</p>
      ) : (
        <div style={card}>
          <Step label="When">
            <Sentence>
              <Pill
                label="Who"
                strong={false}
                value={who}
                options={[
                  { value: 'others', label: 'someone else' },
                  { value: 'anyone', label: 'anyone' },
                ]}
                onChange={setWho}
              />
              <span>adds</span>
              <Pill
                label="What"
                value={collection}
                options={offered.map((c) => ({
                  value: c.name,
                  label: `a ${collectionLabel(c).toLowerCase()}`,
                }))}
                onChange={(name) => {
                  setCollection(name);
                  setClauses([]);
                }}
              />
              <span>in</span>
              <Pill
                label="Where"
                strong={false}
                value={where}
                options={[
                  { value: 'space', label: space.name },
                  { value: 'all', label: 'any of my spaces' },
                ]}
                onChange={setWhere}
              />
            </Sentence>
          </Step>
          <Step label="Only if">
            <ClauseList
              fields={fields}
              clauses={clauses}
              onChange={setClauses}
              people={people}
              me={did}
              empty={
                fields.length === 0
                  ? `A ${thing.toLowerCase()} has nothing to narrow it down by: you'll hear about every new one.`
                  : `Every new ${thing.toLowerCase()}, or narrow it down:`
              }
            />
          </Step>
        </div>
      )}

      {chosen && (
        <div style={previewBox} aria-live="polite">
          {preview === null ? (
            <span style={{ color: palette.ink.faint }}>Looking at what's here…</span>
          ) : preview.matched.length === 0 ? (
            <span style={{ color: palette.ink.muted }}>
              None of the last {preview.looked || 'few'} {thing.toLowerCase()}s here match. You'll hear about
              the next one that does.
            </span>
          ) : (
            <>
              <span style={{ color: palette.ink.muted }}>
                Lately, this would have told you about {preview.matched.length} of the last {preview.looked}:
              </span>
              <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {preview.matched.slice(0, 4).map((record) => (
                  <li key={record.key} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                    <span style={{ color: palette.ink.faint }}>●</span>
                    <span style={{ flex: 1, minWidth: 0, color: palette.ink.strong }}>
                      {recordLabel(record, chosen.schema)}
                    </span>
                    <span style={{ fontSize: 12, color: palette.ink.faint }}>{ago(record.createdAt)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {chosen && (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={styles.fieldLabel}>The notification says</span>
          <input
            value={shown}
            maxLength={120}
            onChange={(event) => setLabel(event.target.value)}
            style={styles.input}
          />
        </label>
      )}

      {permission === 'denied' && (
        <p style={{ ...styles.errorHint, marginTop: 0 }}>
          Notifications are blocked for this site: allow them from the icon left of the address first.
        </p>
      )}
      {error && <p style={{ ...styles.errorHint, marginTop: 0, color: palette.accent.danger }}>{error}</p>}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onClose} data-variant="quiet" style={{ ...styles.smallButton, height: 40 }}>
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={!chosen || asking}
          data-variant="primary"
          style={{ ...styles.button, width: 'auto' }}
        >
          {asking ? 'Confirm in your account…' : 'Notify me'}
        </button>
      </div>
    </Modal>
  );
}
