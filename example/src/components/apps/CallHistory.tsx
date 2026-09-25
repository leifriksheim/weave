import { useAccount, useLive, useNode, useProfiles } from '@weaveprotocol/core/react';
import { call as callSchema, type Call } from '@weaveprotocol/core/schemas';
import { nameOf, peopleFrom, type People } from '../../derive/people';
import { ago } from '../../derive/time';
import { Avatar } from '../Avatar';
import { CallButton } from '../calls/Calls';
import { styles, palette } from '../../styles';
import type { AppProps } from './index';

/**
 * `std.call` as a call log. The calls themselves are live and kept nowhere;
 * adding this app is what makes a space remember them — who was in a call,
 * and who rang who with nobody answering.
 */
export function CallHistory({ space }: AppProps) {
  const node = useNode();
  const { did: me } = useAccount();
  const people = peopleFrom(useProfiles(space.id));
  const history = useLive(space.id, async () => [...(await node.records.list<Call>(space.id, { collection: callSchema.name }))].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)), []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <CallButton space={space} />
        <p style={{ fontSize: 13, color: palette.ink.muted }}>
          A call keeps going while you move between spaces. To ring one person, use Call beside their name in People &amp; roles.
        </p>
      </div>
      {history && history.length === 0 && <div style={{ ...styles.emptyState, padding: '28px 16px' }}>No calls yet.</div>}
      <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column' }}>
        {(history ?? []).map((record) => record.body && <Entry key={record.key} call={record.body} by={record.root} me={me} people={people} />)}
      </ul>
    </div>
  );
}

function Entry({ call, by, me, people }: { call: Call; by: string | null; me: string; people: People }) {
  const missed = call.status === 'missed';
  const who = missed ? (by === me ? call.to : by) : (call.people ?? []).find((did) => did !== me);
  const title = missed
    ? by === me
      ? `You called ${nameOf(call.to, people)} — no answer`
      : `Missed call from ${nameOf(by, people)}`
    : `Call with ${
        (call.people ?? [])
          .filter((did) => did !== me)
          .map((did) => nameOf(did, people))
          .join(', ') || 'nobody'
      }`;
  const minutes = call.endedAt ? Math.max(1, Math.round((Date.parse(call.endedAt) - Date.parse(call.startedAt)) / 60_000)) : null;
  return (
    <li style={{ ...styles.row, padding: '10px 4px', borderBottom: `1px solid ${palette.surface.line}` }}>
      {who ? <Avatar did={who} size={28} /> : <span style={{ width: 28 }} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ fontSize: 14, color: missed && by !== me ? palette.accent.danger : palette.ink.strong }}>{title}</p>
        <p style={{ fontSize: 12, color: palette.ink.faint }}>
          {ago(call.startedAt)}
          {minutes !== null && ` · ${minutes} min`}
        </p>
      </div>
    </li>
  );
}
