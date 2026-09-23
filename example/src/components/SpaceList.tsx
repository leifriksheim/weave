import { useState, type FormEvent } from 'react';
import type { SpaceRecord, SpaceType, SpaceVisibility } from '@p2p-web/protocol';
import type { NewSpace } from '../spaces';
import { Modal, Choice } from './Modal';
import { Info } from './Info';
import { styles } from '../styles';

/** How a list is described once it exists. */
export function spaceBadges(space: SpaceRecord['space']): string {
  return `${space.visibility === 'private' ? '🔒 private' : '🌍 public'} · ${
    space.type === 'shared' ? '👥 shared' : '👤 personal'
  }`;
}

/**
 * What a list is, in a sentence, given the two choices behind it.
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
  spaces: ReadonlyArray<SpaceRecord>;
  loading: boolean;
  error: string | null;
  onOpen: (record: SpaceRecord) => void;
  onCreate: (params: NewSpace) => void;
  onJoin: (invite: string) => void;
  onRemove: (spaceId: string) => void;
}) {
  const [dialog, setDialog] = useState<'new' | 'join' | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState<SpaceType>('personal');
  const [visibility, setVisibility] = useState<SpaceVisibility>('private');
  const [invite, setInvite] = useState('');

  const close = () => setDialog(null);

  const create = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;

    onCreate({ name: trimmed, type, visibility });
    setName('');
    close();
  };

  const join = (event: FormEvent) => {
    event.preventDefault();
    if (!invite.trim()) return;

    onJoin(invite.trim());
    setInvite('');
    close();
  };

  return (
    <>
      {loading && spaces.length === 0 && <p style={styles.emptyState}>Loading…</p>}
      {!loading && spaces.length === 0 && (
        <p style={styles.emptyState}>No lists yet.</p>
      )}

      <div style={styles.todoList}>
        {spaces.map((record) => (
          <div key={record.space.id} data-row style={styles.row}>
            <button
              onClick={() => onOpen(record)}
              style={{ ...styles.row, padding: 0, border: 'none' }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={styles.todoText}>{record.space.name}</span>
                <span style={{ ...styles.todoMeta, display: 'block' }}>
                  {spaceBadges(record.space)} · {record.space.members.length}{' '}
                  {record.space.members.length === 1 ? 'member' : 'members'}
                </span>
              </span>
            </button>
            <button
              onClick={() => onRemove(record.space.id)}
              data-row-action
              data-variant="danger"
              style={styles.rowAction}
              title={`Forget ${record.space.name}`}
              aria-label={`Forget ${record.space.name}`}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div style={{ ...styles.linkRow, marginTop: 14 }}>
        <button onClick={() => setDialog('new')} data-variant="primary" style={styles.addButton}>
          New list
        </button>
        <button onClick={() => setDialog('join')} data-variant="ghost" style={styles.linkButton}>
          Join with a link
        </button>
      </div>

      {error && <p style={{ ...styles.error, marginTop: 10 }}>{error}</p>}

      {dialog === 'new' && (
        <Modal title="New list" onClose={close}>
          <form onSubmit={create} style={styles.form}>
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Name this list"
              style={styles.input}
              aria-label="List name"
            />

            <Choice
              label="Who can read it"
              value={visibility}
              onChange={setVisibility}
              options={[
                { value: 'private', label: '🔒 Encrypted' },
                { value: 'public', label: '🌍 Anyone' },
              ]}
            />

            <Choice
              label="Who can write to it"
              value={type}
              onChange={setType}
              options={[
                { value: 'personal', label: '👤 Just me' },
                { value: 'shared', label: '👥 People I invite' },
              ]}
            />

            <p style={styles.errorHint}>{describe(type, visibility)}</p>

            <button type="submit" disabled={!name.trim()} data-variant="primary" style={styles.button}>
              Create list
            </button>
          </form>
        </Modal>
      )}

      {dialog === 'join' && (
        <Modal title="Join a list" onClose={close}>
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
                The list itself and, for a private one, the key that opens it — in the part after
                the <code>#</code>, which browsers never send to a server. So it reaches you
                without passing through whatever is hosting the page.
              </Info>
            </p>
            <button type="submit" disabled={!invite.trim()} data-variant="primary" style={styles.button}>
              Join
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}
