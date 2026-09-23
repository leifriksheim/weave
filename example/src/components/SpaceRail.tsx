import { useState } from 'react';
import type { SpaceSummary } from 'weave-protocol';
import type { NewSpace } from '../spaces';
import { SpaceDialog, SpaceMark } from './SpaceList';
import { palette } from '../styles';

export const RAIL_WIDTH = 68;

/**
 * Every space down the left edge while one is open, the way Slack and Discord
 * do it: one click to switch, a home button back to the grid, and a plus to
 * add another.
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

  return (
    <nav aria-label="Spaces" style={rail}>
      <button onClick={onHome} data-rail-item style={slot} title="All spaces" aria-label="All spaces">
        <span style={{ ...plain, background: palette.ink.strong, color: '#fff' }}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            <rect x="1" y="1" width="6" height="6" rx="1.5" />
            <rect x="9" y="1" width="6" height="6" rx="1.5" />
            <rect x="1" y="9" width="6" height="6" rx="1.5" />
            <rect x="9" y="9" width="6" height="6" rx="1.5" />
          </svg>
        </span>
      </button>

      <span style={{ width: 28, height: 1, background: palette.surface.line, margin: '4px 0' }} />

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, overflowY: 'auto', flex: '0 1 auto', width: '100%' }}>
        {spaces.map((space) => {
          const on = space.id === current;
          return (
            <button
              key={space.id}
              onClick={() => onOpen(space)}
              aria-current={on ? 'page' : undefined}
              data-rail-item
              style={slot}
              title={space.name}
              aria-label={space.name}
            >
              {/* The pill on the edge says which one you are in. */}
              <span data-rail-pill style={{ ...pill, height: on ? 24 : 0, opacity: on ? 1 : 0 }} />
              <span style={{ borderRadius: 12, boxShadow: on ? `0 0 0 2px ${palette.surface.page}, 0 0 0 4px ${palette.ink.strong}` : undefined }}>
                <SpaceMark space={space} size={40} />
              </span>
            </button>
          );
        })}
      </div>

      <button onClick={() => setAdding(true)} data-rail-item data-rail-add style={slot} title="New space" aria-label="New space">
        <span style={{ ...plain, border: `1px dashed ${palette.surface.lineStrong}`, color: palette.ink.muted, fontSize: 22, fontWeight: 400 }}>+</span>
      </button>

      {adding && <SpaceDialog initial="new" onClose={() => setAdding(false)} onCreate={onCreate} onJoin={onJoin} />}
    </nav>
  );
}

const rail = {
  position: 'fixed' as const,
  top: 0,
  bottom: 0,
  left: 0,
  zIndex: 10,
  width: RAIL_WIDTH,
  display: 'flex',
  flexDirection: 'column' as const,
  alignItems: 'center',
  gap: 8,
  padding: '16px 0',
  background: palette.surface.sunken,
  borderRight: `1px solid ${palette.surface.line}`,
};
const slot = {
  position: 'relative' as const,
  width: '100%',
  display: 'flex',
  justifyContent: 'center',
  padding: '2px 0',
  border: 'none',
  background: 'none',
  flexShrink: 0,
};
const plain = {
  width: 40,
  height: 40,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 10,
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
