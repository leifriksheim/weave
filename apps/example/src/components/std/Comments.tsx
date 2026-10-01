import { useRef, useState } from 'react';
import { useAccess, useAccount, useNode, useProfiles } from '@weaveprotocol/core/react';
import type { NodeRecord, SpaceSummary } from '@weaveprotocol/core';
import { comment } from '@weaveprotocol/core/schemas';
import { bodyOf } from '../../derive/schema-ui';
import { ago } from '../../derive/time';
import { Avatar } from '@weave/app-shared/Avatar';
import { styles, palette } from '../../styles';
import { Person } from '../Person';
import { peopleFrom, respondingTo } from '../../derive/people';
import { MentionField, MentionList, MentionText, useMentions } from './Mentions';

/**
 * `std.comment` on a record: a thread, oldest first, and a box to add to it.
 * "@" mentions someone, as in chat, so they can be told.
 */
export function Comments({
  space,
  target,
  targetAuthor,
  comments,
}: {
  space: SpaceSummary;
  target: string;
  /** Who wrote what is commented on, told through `respondingTo` */
  targetAuthor: string | null;
  comments: ReadonlyArray<NodeRecord>;
}) {
  const node = useNode();
  const { did: me } = useAccount();
  const people = peopleFrom(useProfiles(space.id));
  const access = useAccess(space.id);
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const members = access?.members.map((m) => m.did);
  const mention = useMentions({ draft, setDraft, people, members, me, input });
  const sorted = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return (
    <section aria-label="Comments" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <h3 style={styles.sectionTitle}>
        Comments{' '}
        {comments.length > 0 && (
          <span style={{ color: palette.ink.faint, fontWeight: 400 }}>{comments.length}</span>
        )}
      </h3>
      {sorted.map((c) => (
        <div key={c.key} style={{ display: 'flex', gap: 10 }}>
          <Avatar did={c.root ?? c.author} size={26} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13 }}>
              <Person did={c.root} style={{ fontWeight: 600, color: palette.ink.strong }} />
              <span style={{ color: palette.ink.faint }}> · {ago(c.createdAt)}</span>
            </div>
            <p
              style={{
                fontSize: 14,
                lineHeight: 1.5,
                color: palette.ink.body,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              <MentionText text={textIn(c) ?? ''} mentions={mentionsIn(c)} people={people} />
            </p>
          </div>
        </div>
      ))}
      {space.writable && (
        <MentionList
          suggestions={mention.suggestions}
          choice={mention.choice}
          people={people}
          onPick={mention.pick}
          style={{ border: `1px solid ${palette.surface.line}`, borderRadius: 8, overflow: 'hidden' }}
        />
      )}
      {space.writable && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const text = draft.trim();
            if (!text) return;
            setDraft('');
            const mentions = mention.take(text);
            void node.records.put(
              space.id,
              comment.name,
              { text, ...(mentions.length ? { mentions } : {}), ...respondingTo(targetAuthor, me) },
              { links: [{ rel: 'about', to: target }] },
            );
          }}
          style={{ display: 'flex', gap: 8 }}
        >
          <MentionField
            input={input}
            marked={mention.marked}
            value={draft}
            onChange={mention.onChange}
            onSelect={mention.onSelect}
            onKeyDown={mention.onKeyDown}
            placeholder="Write a comment… @ to mention someone"
            aria-label="Write a comment"
            style={styles.input}
          />
          <button
            type="submit"
            disabled={!draft.trim()}
            data-variant="primary"
            style={{ ...styles.addButton }}
          >
            Send
          </button>
        </form>
      )}
    </section>
  );
}

/** Whom a comment mentions */
function mentionsIn(record: NodeRecord): string[] {
  const mentions = bodyOf(record).mentions;
  return Array.isArray(mentions) ? mentions.filter((did) => typeof did === 'string') : [];
}

/** What a comment says */
function textIn(record: NodeRecord): string | null {
  const text = bodyOf(record).text;
  return typeof text === 'string' ? text : null;
}
