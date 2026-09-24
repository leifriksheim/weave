import { useState } from 'react';
import type { NodeRecord, SpaceSummary } from 'weave-protocol';
import { reaction } from 'weave-protocol/schemas';
import { requireSession } from '../../protocol';
import { palette } from '../../styles';

const QUICK = ['👍', '❤️', '🎉', '😂', '👀', '🙏'];

/**
 * `std.reaction` on a record: each emoji with its count, yours highlighted, a
 * click to add or take back — and a small picker for the rest.
 */
export function Reactions({ space, target, reactions }: { space: SpaceSummary; target: string; reactions: ReadonlyArray<NodeRecord> }) {
  const { node, did: rootDid } = requireSession();
  const [picking, setPicking] = useState(false);
  const byEmoji = new Map<string, NodeRecord[]>();
  for (const r of reactions) {
    const emoji = (r.body as { emoji?: string } | null)?.emoji;
    if (emoji) byEmoji.set(emoji, [...(byEmoji.get(emoji) ?? []), r]);
  }

  const toggle = (emoji: string) => {
    setPicking(false);
    const mine = byEmoji.get(emoji)?.find((r) => r.root === rootDid);
    void (mine
      ? node.records.delete(space.id, mine.key)
      : node.records.put(space.id, reaction.name, { emoji }, { links: [{ rel: 'about', to: target }] }));
  };

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', position: 'relative' }} aria-label="Reactions">
      {[...byEmoji].map(([emoji, list]) => {
        const mine = list.some((r) => r.root === rootDid);
        return (
          <button
            key={emoji}
            onClick={() => toggle(emoji)}
            disabled={!space.writable}
            aria-pressed={mine}
            aria-label={`${emoji} ${list.length}${mine ? ', yours' : ''}`}
            style={{ ...pill, borderColor: mine ? palette.ink.strong : palette.surface.line, backgroundColor: mine ? palette.surface.sunken : palette.surface.card }}
          >
            <span>{emoji}</span>
            <span style={{ fontSize: 12, color: palette.ink.muted }}>{list.length}</span>
          </button>
        );
      })}
      {space.writable && (
        <button onClick={() => setPicking((was) => !was)} aria-label="Add a reaction" style={{ ...pill, color: palette.ink.muted }}>
          ☺︎+
        </button>
      )}
      {picking && (
        <div role="menu" style={{ position: 'absolute', top: 34, left: 0, zIndex: 5, display: 'flex', gap: 2, padding: 4, background: palette.surface.card, border: `1px solid ${palette.surface.line}`, borderRadius: 8, boxShadow: '0 8px 24px -12px rgba(0,0,0,.2)' }}>
          {QUICK.map((emoji) => (
            <button key={emoji} role="menuitem" onClick={() => toggle(emoji)} aria-label={`React ${emoji}`} style={{ border: 'none', background: 'none', fontSize: 18, padding: '4px 6px', borderRadius: 6 }}>
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const pill = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 28,
  padding: '0 10px',
  borderRadius: 999,
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: palette.surface.line,
  backgroundColor: palette.surface.card,
  fontSize: 14,
};

/** 👍 3 · ❤️ 1 — a record's reactions in a few characters, for a list row */
export function reactionSummary(reactions: ReadonlyArray<NodeRecord> | number | undefined): string {
  if (!Array.isArray(reactions) || reactions.length === 0) return '';
  const counts = new Map<string, number>();
  for (const r of reactions) {
    const emoji = (r.body as { emoji?: string } | null)?.emoji;
    if (emoji) counts.set(emoji, (counts.get(emoji) ?? 0) + 1);
  }
  return [...counts].slice(0, 3).map(([emoji, n]) => `${emoji} ${n}`).join('  ');
}
