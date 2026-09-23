import { useState, type FormEvent } from 'react';
import type { SpaceSummary } from '@p2p-web/protocol';
import { useSpaceSession } from '../hooks/useSpaceSession';
import { createInviteLink } from '../spaces';
import { TodoItem } from './TodoItem';
import { DelegationPanel } from './DelegationPanel';
import { spaceBadges } from './SpaceList';
import type { Session } from '../protocol';
import { styles, palette } from '../styles';

const CONNECTION_LABEL: Record<string, string> = {
  offline: '○ offline',
  connecting: '◌ connecting',
  connected: '● connected',
  error: '○ no relay',
};

/** One open list: its todos, its peers, and the link that invites someone in. */
export function SpaceView({
  record,
  session,
  onBack,
}: {
  record: SpaceSummary;
  session: Session;
  onBack: () => void;
}) {
  const { todos, status, collections, loading, add, toggle, remove } = useSpaceSession(record);
  const [draft, setDraft] = useState('');
  const [invite, setInvite] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const space = record;
  const completed = todos.filter((todo) => todo.body.completed).length;

  const handleAdd = async (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    await add(text);
  };

  const share = async () => {
    const link = await createInviteLink(space.id);
    setInvite(link);
    try {
      await globalThis.navigator.clipboard.writeText(link);
      setCopied(true);
      globalThis.setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <>
      <header style={styles.header}>
        <button onClick={onBack} data-variant="ghost" style={styles.linkButton}>
          ← All lists
        </button>
        <h1 style={{ ...styles.appTitle, fontSize: 22 }}>{space.name}</h1>
        <div style={styles.identityBar}>
          <span style={styles.badge}>{spaceBadges(space)}</span>
          <span style={styles.badge} title={`Relay: peers currently connected to this space`}>
            {CONNECTION_LABEL[status.connection]} · {status.peers.length}{' '}
            {status.peers.length === 1 ? 'peer' : 'peers'}
          </span>
          <span style={styles.badge} title={status.mstRoot ?? 'No root yet'}>
            🌳 {status.mstRoot ? `${status.mstRoot.slice(0, 10)}…` : 'empty'}
          </span>
          {status.rejected > 0 && (
            <span style={{ ...styles.badge, color: palette.accent.danger }} title="Expressions peers sent that failed validation">
              ⚠️ {status.rejected} rejected
            </span>
          )}
        </div>
      </header>

      {!space.writable && (
        <p style={styles.errorHint}>
          👀 You are following this list. It is {space.owner.slice(-6)}'s personal list, so only they can
          change it — ask them for a shared list to edit together.
        </p>
      )}

      {space.writable && (
        <form onSubmit={handleAdd} style={styles.addForm}>
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="What needs to be done?"
            style={styles.todoInput}
            autoFocus
          />
          <button type="submit" disabled={!draft.trim()} data-variant="primary" style={styles.addButton}>
            Add
          </button>
        </form>
      )}

      <div style={styles.todoList}>
        {loading && todos.length === 0 && <p style={styles.emptyState}>Opening…</p>}
        {!loading && todos.length === 0 && (
          <p style={styles.emptyState}>Nothing here yet. Add the first item.</p>
        )}
        {todos.map((todo) => (
          <TodoItem
            key={todo.id}
            todo={todo}
            onToggle={() => void toggle(todo)}
            onDelete={() => void remove(todo.id)}
            readOnly={!space.writable}
          />
        ))}
      </div>

      {todos.length > 0 && (
        <footer style={styles.footer}>
          <span>
            {completed}/{todos.length} completed
          </span>
          <span style={styles.footerHint}>
            {space.visibility === 'private'
              ? 'Encrypted before signing — peers relay what they cannot read'
              : 'Signed in the clear — anyone holding it can verify it'}
          </span>
        </footer>
      )}

      <section style={styles.panelSection}>
        <h2 style={styles.sectionTitle}>Share this list</h2>
        <p style={styles.hint}>
          {space.type === 'shared'
            ? 'Anyone who opens this link joins as a member and can write.'
            : 'This is a personal list: the link lets others follow along, but the gate only accepts writes signed by you.'}
          {space.visibility === 'private' &&
            ' The space key travels in the link fragment, so it never reaches a server — treat the link as the secret it is.'}
        </p>
        <button onClick={share} data-variant="primary" style={styles.addButton}>
          {copied ? 'Link copied' : 'Create invite link'}
        </button>
        {invite && <code style={styles.token}>{invite}</code>}
      </section>

      <details style={styles.panel}>
        <summary data-variant="ghost" style={styles.panelSummary}>📚 What this list holds</summary>
        <div style={styles.panelBody}>
          <p style={styles.errorHint}>
            The list describes its own contents, so another app — or an agent — can open it and know what a
            todo is without this app's code.
          </p>
          {collections.map((collection) => (
            <div key={collection.name} style={styles.chainRow}>
              <span>{collection.title ?? collection.name}</span>
              <code>{collection.name}</code>
              <span>
                {collection.records} {collection.records === 1 ? 'record' : 'records'}
                {collection.version !== null ? ` · v${collection.version}` : ' · undescribed'}
              </span>
            </div>
          ))}
        </div>
      </details>

      <DelegationPanel session={session} spaceId={space.id} />
    </>
  );
}
