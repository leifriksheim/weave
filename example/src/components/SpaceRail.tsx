import { useState } from 'react';
import type { SpaceSummary } from '@weaveprotocol/core';
import type { NewSpace } from '@weaveprotocol/core';
import { SpaceDialog, SpaceMark } from './SpaceList';
import { palette } from '../styles';
import { useCallSpaces } from './calls/Calls';

/**
 * Every space down the left edge while one is open, the way Slack and Discord
 * do it: one click to switch, a home button back to the grid, and a plus to
 * add another. On a phone it runs along the bottom instead — see `.rail` in
 * styles.ts.
 */
export function SpaceRail({
  spaces,
  current,
  onOpen,
  onHome,
  onCreate,
  onJoin,
}: {
  spaces: ReadonlyArray<SpaceSummary>;
  current: string;
  onOpen: (space: SpaceSummary) => void;
  onHome: () => void;
  onCreate: (params: NewSpace) => void;
  onJoin: (invite: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const calls = useCallSpaces();

  return (
    <nav aria-label="Spaces" className="rail">
      <button onClick={onHome} data-rail-item className="rail-slot" title="All spaces" aria-label="All spaces">
        <span style={{ ...plain, background: palette.ink.strong, color: '#fff' }}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            <rect x="1" y="1" width="6" height="6" rx="1.5" />
            <rect x="9" y="1" width="6" height="6" rx="1.5" />
            <rect x="1" y="9" width="6" height="6" rx="1.5" />
            <rect x="9" y="9" width="6" height="6" rx="1.5" />
          </svg>
        </span>
      </button>

      <span className="rail-divider" />

      <div className="rail-list">
        {spaces.map((space) => {
          const on = space.id === current;
          return (
            <button
              key={space.id}
              onClick={() => onOpen(space)}
              aria-current={on ? 'page' : undefined}
              data-rail-item
              className="rail-slot"
              title={space.name}
              aria-label={space.name}
            >
              {/* The pill on the edge says which one you are in. */}
              <span data-rail-pill style={{ ...pill, height: on ? 24 : 0, opacity: on ? 1 : 0 }} />
              <span style={{ borderRadius: 12, boxShadow: on ? `0 0 0 2px ${palette.surface.page}, 0 0 0 4px ${palette.ink.strong}` : undefined }}>
                <SpaceMark space={space} size={40} />
              </span>
              {(calls.mine === space.id || calls.others.has(space.id)) && (
                <span
                  aria-label={calls.mine === space.id ? 'Your call is here' : 'A call is going on here'}
                  title={calls.mine === space.id ? 'Your call is here' : 'A call is going on here'}
                  style={{ ...callDot, background: calls.mine === space.id ? palette.accent.good : palette.surface.card, borderColor: palette.accent.good }}
                />
              )}
            </button>
          );
        })}
      </div>

      <button onClick={() => setAdding(true)} data-rail-item data-rail-add className="rail-slot" title="New space" aria-label="New space">
        <span style={{ ...plain, border: `1px dashed ${palette.surface.lineStrong}`, color: palette.ink.muted, fontSize: 22, fontWeight: 400 }}>+</span>
      </button>

      {adding && <SpaceDialog initial="new" onClose={() => setAdding(false)} onCreate={onCreate} onJoin={onJoin} />}
    </nav>
  );
}

const plain = {
  width: 40,
  height: 40,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 10,
};
/** A spot on a space's corner while a call goes on in it: filled when it's yours */
const callDot = {
  position: 'absolute' as const,
  right: 10,
  bottom: 0,
  width: 12,
  height: 12,
  borderRadius: 6,
  border: '2px solid',
  boxShadow: `0 0 0 2px ${palette.surface.sunken}`,
};
const pill = {
  position: 'absolute' as const,
  left: 0,
  top: '50%',
  transform: 'translateY(-50%)',
  width: 4,
  borderRadius: '0 4px 4px 0',
  background: palette.ink.strong,
  transition: 'height .15s ease, opacity .15s ease',
};
