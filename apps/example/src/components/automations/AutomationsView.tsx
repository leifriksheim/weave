import { useState, type ReactNode } from 'react';
import type { NodeCollection, NodeRecord, SpaceSummary } from '@weaveprotocol/core';
import { useAccount, useConnection, useLive, useNode } from '@weaveprotocol/core/react';
import { nameOf } from '../../derive/people';
import { ago } from '../../derive/time';
import { useSubscriptions } from '../../notifications';
import {
  rule as ruleCollection,
  ruleOf,
  ruleRun as runCollection,
  type RuleRun,
} from '@weaveprotocol/core/schemas';
import { ideas, ruleWords, type PickedRule } from '../../rules';
import { Person, usePeopleHere } from '../Person';
import { Icon } from '../Icon';
import { styles, palette } from '../../styles';
import { RuleBuilder } from './RuleBuilder';
import { WatchBuilder } from './WatchBuilder';

type Open =
  | { readonly kind: 'watch' }
  | { readonly kind: 'rule'; readonly editing?: NodeRecord; readonly start?: PickedRule }
  | null;

/**
 * What the space does without anyone doing it: the notifications you asked
 * for here, and the rules people made — each in a sentence, with what it
 * did lately. Everyone sees every rule; only its maker changes it, and only
 * their devices run it.
 */
export function AutomationsView({
  space,
  collections,
}: {
  space: SpaceSummary;
  collections: ReadonlyArray<NodeCollection>;
}) {
  const node = useNode();
  const { did } = useAccount();
  const { state } = useConnection();
  const here = usePeopleHere();
  const people = here?.people ?? new Map();
  const [open, setOpen] = useState<Open>(null);
  const [error, setError] = useState<string | null>(null);

  const watches = useSubscriptions().filter((sub) => sub.spaces === 'all' || sub.spaces.includes(space.id));
  const defined = collections.some((c) => c.name === ruleCollection.name && c.version !== null);
  const rules = useLive(
    space.id,
    async (n) => {
      if (!defined) return { rules: [], runs: new Map<string, NodeRecord<RuleRun>[]>() };
      const [rules, runs] = await Promise.all([
        n.records.list(space.id, { collection: ruleCollection.name }),
        n.records.list<RuleRun>(space.id, { collection: runCollection.name, newestFirst: true }),
      ]);
      const byRule = new Map<string, NodeRecord<RuleRun>[]>();
      for (const run of runs) {
        const rule = run.links.find((l) => l.rel === 'rule')?.to;
        if (rule) byRule.set(rule, [...(byRule.get(rule) ?? []), run]);
      }
      return { rules: rules.filter((r) => ruleOf(r) !== null), runs: byRule };
    },
    [defined],
  );
  // An idea already turned on is not offered again.
  const made = new Set((rules?.rules ?? []).map((r) => ruleOf(r)?.name));
  const starters = ideas(collections).filter((idea) => !made.has(idea.rule.name));
  const who = (d: string) => nameOf(d, people);

  const act = (work: () => Promise<unknown>) => {
    setError(null);
    work().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 36, maxWidth: 760 }}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <h2 style={{ ...styles.appTitle, fontSize: 22 }}>Automations</h2>
        <p style={{ fontSize: 14, color: palette.ink.muted, lineHeight: 1.55 }}>
          Hear about what matters to you in {space.name}, and let the space look after the rest: close a poll
          once enough people voted, tell the chat when a task is done.
        </p>
      </header>

      <section style={section}>
        <SectionHead
          title="Notify me"
          about="Only you see these. This app lets you know while it's open."
          action="New notification"
          onAction={() => setOpen({ kind: 'watch' })}
        />
        {watches.length === 0 ? (
          <Empty>You haven't asked to hear about anything here yet.</Empty>
        ) : (
          <ul style={list}>
            {watches.map((sub) => (
              <li key={sub.id} style={row}>
                <span style={iconDot}>
                  <Icon name={sub.paused ? 'bell' : 'bellOn'} size={14} />
                </span>
                <span style={{ flex: 1, minWidth: 0, opacity: sub.paused ? 0.55 : 1 }}>
                  <span style={{ display: 'block', color: palette.ink.strong, fontWeight: 500 }}>
                    {sub.label}
                  </span>
                  <span style={{ fontSize: 12.5, color: palette.ink.muted }}>
                    {sub.spaces === 'all' ? 'In all your spaces' : `In ${space.name}`}
                    {sub.where !== undefined ? ' · with conditions' : ''}
                    {sub.paused ? ' · paused' : ''}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {watches.length > 0 && (
          <button
            onClick={() =>
              globalThis.open(
                `${new URL('.', state.home).href}#notifications`,
                'weave-account',
                'popup,width=720,height=820',
              )
            }
            data-variant="ghost"
            style={{ ...styles.linkButton, alignSelf: 'flex-start' }}
          >
            Pause or remove them in your account ↗
          </button>
        )}
      </section>

      <section style={section}>
        <SectionHead
          title="Rules"
          about="Everyone here sees these. Each runs on its maker's devices, as them."
          action="New rule"
          onAction={() => setOpen({ kind: 'rule' })}
          disabled={!space.writable}
        />
        {rules === undefined ? null : rules.rules.length === 0 ? (
          <Empty>No rules in {space.name} yet.</Empty>
        ) : (
          <ul style={list}>
            {rules.rules.map((record) => {
              const rule = ruleOf(record)!;
              const mine = record.createdBy === did;
              // An agent's rule waits for its person to save it themselves.
              const suggested = record.viaAgent === true;
              const off = rule.paused || suggested;
              const agentOnly = rule.then.kind === 'ask' || (!rule.when && !!rule.every);
              const runs = rules.runs.get(record.key) ?? [];
              return (
                <li key={record.key} style={{ ...ruleCard, opacity: off ? 0.65 : 1 }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                    <span
                      style={{
                        ...iconDot,
                        background: off ? palette.surface.sunken : palette.ink.strong,
                        color: off ? palette.ink.muted : '#fff',
                      }}
                    >
                      <Icon name="bolt" size={14} />
                    </span>
                    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <strong style={{ color: palette.ink.strong, fontSize: 14.5 }}>{rule.name}</strong>
                      <span style={{ fontSize: 14, color: palette.ink.body, lineHeight: 1.5 }}>
                        {ruleWords(rule, collections, who)}
                      </span>
                      <span style={{ fontSize: 12.5, color: palette.ink.muted }}>
                        {suggested ? 'Suggested by an agent' : rule.paused ? 'Paused' : 'On'} · made by{' '}
                        {mine ? 'you' : <Person did={record.createdBy} />} ·{' '}
                        {rule.by ? (
                          <>
                            run by <Person did={rule.by} />
                          </>
                        ) : agentOnly ? (
                          `runs while ${mine ? 'your' : 'their'} agent does (weave agent)`
                        ) : mine ? (
                          'runs while this app is open on one of your devices'
                        ) : (
                          'runs while they have this app open'
                        )}
                      </span>
                    </div>
                    {mine && (
                      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                        <button
                          onClick={() =>
                            act(() =>
                              node.records.update(space.id, record.key, {
                                ...rule,
                                paused: !off,
                                since: off ? new Date().toISOString() : rule.since,
                              }),
                            )
                          }
                          data-variant="quiet"
                          style={styles.smallButton}
                        >
                          {off ? 'Turn on' : 'Pause'}
                        </button>
                        <button
                          onClick={() => setOpen({ kind: 'rule', editing: record })}
                          data-variant="quiet"
                          style={styles.smallButton}
                        >
                          Change
                        </button>
                        <button
                          onClick={() => {
                            if (globalThis.confirm(`Delete the rule “${rule.name}”?`))
                              act(() => node.records.delete(space.id, record.key));
                          }}
                          data-variant="danger"
                          aria-label={`Delete ${rule.name}`}
                          style={{ ...styles.smallButton, color: palette.accent.danger }}
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                  {runs.length > 0 && (
                    <ul
                      style={{
                        listStyle: 'none',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 3,
                        paddingLeft: 38,
                      }}
                    >
                      {runs.slice(0, 3).map((run) => (
                        <li
                          key={run.key}
                          style={{ fontSize: 12.5, display: 'flex', gap: 6, color: palette.ink.muted }}
                        >
                          <span style={{ color: run.body?.ok ? palette.accent.good : palette.accent.danger }}>
                            {run.body?.ok ? '✓' : '!'}
                          </span>
                          <span style={{ flex: 1, minWidth: 0 }}>{run.body?.did ?? 'Ran'}</span>
                          <span style={{ color: palette.ink.faint }}>{ago(run.updatedAt)}</span>
                        </li>
                      ))}
                      {runs.length > 3 && (
                        <li style={{ fontSize: 12, color: palette.ink.faint }}>
                          and {runs.length - 3} earlier
                        </li>
                      )}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {error && <p style={{ ...styles.error, fontSize: 13 }}>{error}</p>}

        {space.writable && starters.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            <p style={styles.fieldLabel}>Ideas for {space.name}</p>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                gap: 8,
              }}
            >
              {starters.map((idea) => (
                <button
                  key={idea.title}
                  onClick={() => setOpen({ kind: 'rule', start: idea.rule })}
                  data-tile
                  style={ideaTile}
                >
                  <Icon name="bolt" size={14} />
                  <span style={{ fontSize: 13.5, color: palette.ink.strong, lineHeight: 1.4 }}>
                    {idea.title}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      {open?.kind === 'watch' && (
        <WatchBuilder space={space} collections={collections} onClose={() => setOpen(null)} />
      )}
      {open?.kind === 'rule' && (
        <RuleBuilder
          space={space}
          collections={collections}
          {...(open.editing ? { editing: open.editing } : {})}
          {...(open.start ? { start: open.start } : {})}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

function SectionHead({
  title,
  about,
  action,
  onAction,
  disabled,
}: {
  title: string;
  about: string;
  action: string;
  onAction: () => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
      <div style={{ flex: 1, minWidth: 200 }}>
        <h3 style={{ ...styles.sectionTitle, fontSize: 16 }}>{title}</h3>
        <p style={{ fontSize: 13, color: palette.ink.muted, marginTop: 2 }}>{about}</p>
      </div>
      <button
        onClick={onAction}
        disabled={disabled}
        data-variant="primary"
        style={{
          ...styles.addButton,
          height: 34,
          fontSize: 13,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <Icon name="plus" size={13} /> {action}
      </button>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <p
      style={{
        padding: '18px 16px',
        borderRadius: 10,
        border: `1px dashed ${palette.surface.lineStrong}`,
        color: palette.ink.muted,
        fontSize: 13.5,
        textAlign: 'center',
      }}
    >
      {children}
    </p>
  );
}

const section = { display: 'flex', flexDirection: 'column', gap: 12 } as const;
const list = { listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 } as const;
const row = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 12px',
  border: `1px solid ${palette.surface.line}`,
  borderRadius: 10,
} as const;
const ruleCard = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: 14,
  border: `1px solid ${palette.surface.line}`,
  borderRadius: 12,
} as const;
const iconDot = {
  width: 28,
  height: 28,
  borderRadius: 8,
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: palette.surface.sunken,
  color: palette.ink.body,
} as const;
const ideaTile = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  padding: '12px 14px',
  borderRadius: 10,
  border: `1px solid ${palette.surface.line}`,
  background: palette.surface.card,
  color: palette.ink.muted,
  textAlign: 'left',
} as const;
