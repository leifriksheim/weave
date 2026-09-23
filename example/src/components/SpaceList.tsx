import { useState, type FormEvent } from 'react';
import type { SpaceSummary, SpaceType, SpaceVisibility } from 'weave-protocol';
import type { NewSpace } from '../spaces';
import { Modal, Choice } from './Modal';
import { Info } from './Info';
import { styles, palette } from '../styles';

/** How a space is described once it exists. */
export function spaceBadges(space: Pick<SpaceSummary, 'type' | 'visibility'>): string {
  return `${space.visibility === 'private' ? 'private' : 'public'} · ${
    space.type === 'shared' ? 'shared' : 'personal'
  }`;
}

/** A small deterministic hash, so a space keeps its colour everywhere it appears. */
function hue(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0) % 360;
}

/**
 * A space's icon: its first letter on a tint worked out from its id.
 *
 * Nothing stored, and the same in the grid and in the rail, so a space is
 * recognisable at a glance in both.
 */
export function SpaceMark({ space, size = 40 }: { space: Pick<SpaceSummary, 'id' | 'name'>; size?: number }) {
  const h = hue(space.id);
  const letter = [...space.name.trim()][0]?.toUpperCase() ?? '·';
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: Math.round(size / 4),
        background: `hsl(${h} 46% 92%)`,
        color: `hsl(${h} 55% 32%)`,
        fontSize: Math.round(size * 0.42),
        fontWeight: 600,
        letterSpacing: '-0.02em',
      }}
    >
      {letter}
    </span>
  );
}

/**
 * What a space is, in a sentence, given the two choices behind it.
 *
 * Shown live in the dialog: four combinations is more than anyone will hold in
 * their head from labels alone, and the consequences are worth being sure of
 * before there is data in one.
 */
function describe(type: SpaceType, visibility: SpaceVisibility): string {
  if (type === 'personal') {
    return visibility === 'private'
      ? 'Encrypted, and only your key can write to it.'
      : 'Anyone you hand it to can read it. Only you can write.';
  }
  return visibility === 'private'
    ? 'Encrypted for the people you invite. The relay never sees what is in it.'
    : 'Anyone with the link can read and write.';
}

export function SpaceList({
  spaces,
  loading,
  error,
  onOpen,
  onCreate,
  onJoin,
  onRemove,
}: {
  spaces: ReadonlyArray<SpaceSummary>;
  loading: boolean;
  error: string | null;
  onOpen: (space: SpaceSummary) => void;
  onCreate: (params: NewSpace) => void;
  onJoin: (invite: string) => void;
  onRemove: (spaceId: string) => void;
}) {
  const [dialog, setDialog] = useState<'new' | 'join' | null>(null);

  return (
    <>
      {loading && spaces.length === 0 && <p style={styles.emptyState}>Loading…</p>}

      {!(loading && spaces.length === 0) && (
        <div className="space-grid">
          {spaces.map((space) => (
            <div key={space.id} data-tile style={tile}>
              <button onClick={() => onOpen(space)} style={tileButton}>
                <SpaceMark space={space} />
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  <span style={{ ...styles.todoText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {space.name}
                  </span>
                  <span style={{ ...styles.todoMeta, marginTop: 0 }}>
                    {spaceBadges(space)} · {space.members.length}{' '}
                    {space.members.length === 1 ? 'member' : 'members'}
                  </span>
                </span>
              </button>
              <button
                onClick={() => onRemove(space.id)}
                data-row-action
                data-variant="danger"
                style={{ ...styles.rowAction, position: 'absolute', top: 10, right: 10 }}
                title={`Forget ${space.name}`}
                aria-label={`Forget ${space.name}`}
              >
                ✕
              </button>
            </div>
          ))}

          <button onClick={() => setDialog('new')} data-tile-new style={newTile}>
            <span style={{ fontSize: 22, lineHeight: 1, fontWeight: 400 }}>+</span>
            <span>New space</span>
          </button>
        </div>
      )}

      <div style={{ ...styles.linkRow, marginTop: 12 }}>
        <button onClick={() => setDialog('join')} data-variant="ghost" style={{ ...styles.linkButton, paddingLeft: 0 }}>
          Have an invite? Join with a link
        </button>
      </div>

      {error && <p style={{ ...styles.error, marginTop: 10 }}>{error}</p>}

      {dialog && (
        <SpaceDialog
          initial={dialog}
          onClose={() => setDialog(null)}
          onCreate={onCreate}
          onJoin={onJoin}
        />
      )}
    </>
  );
}

const tile = {
  position: 'relative' as const,
  borderRadius: palette.radius.lg,
  border: `1px solid ${palette.surface.line}`,
  background: palette.surface.card,
};
const tileButton = {
  width: '100%',
  minHeight: 132,
  display: 'flex',
  flexDirection: 'column' as const,
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: 16,
  padding: 16,
  border: 'none',
  borderRadius: palette.radius.lg,
  background: 'none',
  textAlign: 'left' as const,
};
const newTile = {
  minHeight: 134,
  display: 'flex',
  flexDirection: 'column' as const,
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  borderRadius: palette.radius.lg,
  border: `1px dashed ${palette.surface.lineStrong}`,
  background: 'none',
  color: palette.ink.muted,
  fontSize: 14,
  fontWeight: 500,
};

/**
 * Making a space, or joining one from a link — the two ways a space arrives,
 * in one dialog so either entry point can reach both.
 */
export function SpaceDialog({
  initial,
  onClose,
  onCreate,
  onJoin,
}: {
  initial: 'new' | 'join';
  onClose: () => void;
  onCreate: (params: NewSpace) => void;
  onJoin: (invite: string) => void;
}) {
  const [mode, setMode] = useState(initial);
  const [name, setName] = useState('');
  const [type, setType] = useState<SpaceType>('personal');
  const [visibility, setVisibility] = useState<SpaceVisibility>('private');
  const [invite, setInvite] = useState('');

  const create = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    onCreate({ name: trimmed, type, visibility });
    onClose();
  };

  const join = (event: FormEvent) => {
    event.preventDefault();
    if (!invite.trim()) return;
    onJoin(invite.trim());
    onClose();
  };

  if (mode === 'join') {
    return (
      <Modal title="Join a space" onClose={onClose}>
        <form onSubmit={join} style={styles.form}>
          <input
            type="text"
            value={invite}
            onChange={(event) => setInvite(event.target.value)}
            placeholder="Paste an invite link"
            style={styles.input}
            spellCheck={false}
            aria-label="Invite link"
          />
          <p style={styles.errorHint}>
            Paste a link someone shared with you.
            <Info label="What an invite link carries">
              The space itself and, for a private one, the key that opens it — in the part after
              the <code>#</code>, which browsers never send to a server. So it reaches you
              without passing through whatever is hosting the page.
            </Info>
          </p>
          <button type="submit" disabled={!invite.trim()} data-variant="primary" style={styles.button}>
            Join
          </button>
          <button type="button" onClick={() => setMode('new')} data-variant="ghost" style={{ ...styles.linkButton, alignSelf: 'center' }}>
            Make a new space instead
          </button>
        </form>
      </Modal>
    );
  }

  return (
    <Modal title="New space" onClose={onClose}>
      <form onSubmit={create} style={styles.form}>
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Name this space"
          style={styles.input}
          aria-label="Space name"
        />

        <Choice
          label="Who can read it"
          value={visibility}
          onChange={setVisibility}
          options={[
            { value: 'private', label: 'Encrypted' },
            { value: 'public', label: 'Anyone' },
          ]}
        />

        <Choice
          label="Who can write to it"
          value={type}
          onChange={setType}
          options={[
            { value: 'personal', label: 'Just me' },
            { value: 'shared', label: 'People I invite' },
          ]}
        />

        <p style={styles.errorHint}>{describe(type, visibility)}</p>

        <button type="submit" disabled={!name.trim()} data-variant="primary" style={styles.button}>
          Create space
        </button>
        <button type="button" onClick={() => setMode('join')} data-variant="ghost" style={{ ...styles.linkButton, alignSelf: 'center' }}>
          Have an invite link? Join instead
        </button>
      </form>
    </Modal>
  );
}
