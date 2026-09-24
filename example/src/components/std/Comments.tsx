import { useState } from 'react';
import { useNode } from 'weave-protocol/react';
import type { NodeRecord, SpaceSummary } from 'weave-protocol';
import { comment } from 'weave-protocol/schemas';
import { nameOf, type People } from '../../derive/people';
import { ago } from '../../derive/time';
import { Avatar } from '../Avatar';
import { styles, palette } from '../../styles';

/** `std.comment` on a record: a thread, oldest first, and a box to add to it. */
export function Comments({ space, target, comments, people }: { space: SpaceSummary; target: string; comments: ReadonlyArray<NodeRecord>; people: People }) {
  const node = useNode();
  const [draft, setDraft] = useState('');
  const sorted = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return (
    <section aria-label="Comments" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <h3 style={styles.sectionTitle}>Comments {comments.length > 0 && <span style={{ color: palette.ink.faint, fontWeight: 400 }}>{comments.length}</span>}</h3>
      {sorted.map((c) => (
        <div key={c.key} style={{ display: 'flex', gap: 10 }}>
          <Avatar did={c.root ?? c.author} size={26} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13 }}>
              <strong style={{ fontWeight: 600, color: palette.ink.strong }}>{nameOf(c.root, people)}</strong>
              <span style={{ color: palette.ink.faint }}> · {ago(c.createdAt)}</span>
            </div>
            <p style={{ fontSize: 14, lineHeight: 1.5, color: palette.ink.body, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{(c.body as { text?: string } | null)?.text}</p>
          </div>
        </div>
      ))}
      {space.writable && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const text = draft.trim();
            if (!text) return;
            setDraft('');
            void node.records.put(space.id, comment.name, { text }, { links: [{ rel: 'about', to: target }] });
          }}
          style={{ display: 'flex', gap: 8 }}
        >
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Write a comment…" aria-label="Write a comment" style={{ ...styles.input, flex: 1 }} />
          <button type="submit" disabled={!draft.trim()} data-variant="primary" style={{ ...styles.addButton }}>
            Send
          </button>
        </form>
      )}
    </section>
  );
}
