import { useCallback, useEffect, useState } from 'react';
import type {
  ContactRequest,
  ContactView,
  DoorView,
  KnockView,
  SentKnockView,
  SpaceSummary,
} from '@weaveprotocol/core';
import { parseDoorCode } from '@weaveprotocol/core/doors';
import { useAccount, useNode } from '@weaveprotocol/core/react';
import { clearDoorFromUrl, doorLink, readDoorFromUrl, takeBack, useContacts, useStanding } from '../contacts';
import { nameOf, peopleFrom } from '../derive/people';
import { ago } from '../derive/time';
import { Avatar } from './Avatar';
import { Modal } from './Modal';
import { styles, palette } from '../styles';

/** How often to look in the doors' mailboxes: knocks wait on relays, which tell nobody */
const KNOCK_POLL_MS = 30_000;

/** Nobody's profile: names here come from the contact list, or the tail of an identity */
const nobody = peopleFrom([]);

/**
 * People: your contacts, who is asking to be one, and your doors.
 *
 * Every contact is a private space for two. Someone who shares a space with
 * you asks there (a sealed `std.contact-request` only you can open); someone
 * who doesn't knocks on a door whose link you gave them. Either way, accepting
 * joins the space for two they made.
 */
export function ContactsView({
  spaces,
  onOpen,
}: {
  spaces: ReadonlyArray<SpaceSummary>;
  onOpen: (spaceId: string) => void;
}) {
  const node = useNode();
  const contacts = useContacts();
  const [requests, setRequests] = useState<ReadonlyArray<ContactRequest>>([]);
  const [knocks, setKnocks] = useState<ReadonlyArray<KnockView>>([]);
  const [sent, setSent] = useState<ReadonlyArray<SentKnockView>>([]);
  const [doors, setDoors] = useState<ReadonlyArray<DoorView>>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  /** Runs an action, shows what went wrong, and loads everything again */
  const act = useCallback(
    async (action: () => Promise<unknown>) => {
      setError(null);
      try {
        await action();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
      reload();
    },
    [reload],
  );

  // Requests are records in the spaces you share, so a change in any of them may bring one.
  const shared = spaces.filter((space) => !space.joining);
  const sharedIds = shared.map((space) => space.id).join(',');
  useEffect(() => {
    let stopped = false;
    void Promise.all(
      shared.map((space) => node.contacts.requests(space.id).catch(() => [] as ContactRequest[])),
    ).then((found) => !stopped && setRequests(found.flat()));
    return () => {
      stopped = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node, sharedIds, tick]);

  useEffect(() => {
    const ids = new Set(sharedIds.split(','));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = node.subscribe((event) => {
      if ((event.type === 'records' && ids.has(event.space)) || event.type === 'spaces') {
        clearTimeout(timer);
        timer = setTimeout(reload, 400);
      }
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [node, sharedIds, reload]);

  // Doors, and the knocks at them. Reading knocks also turns answered knocks of yours into contacts.
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      const [open, waiting, left] = await Promise.all([
        node.doors.list().catch(() => []),
        node.doors.knocks().catch(() => []),
        node.doors.sent().catch(() => []),
      ]);
      if (stopped) return;
      setDoors(open);
      setKnocks(waiting);
      setSent(left);
    };
    void load();
    const timer = setInterval(() => void load(), KNOCK_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [node, tick]);

  // Where a request of yours may be waiting, to take back with it.
  const writable = shared.filter((space) => space.writable).map((space) => space.id);
  const spaceName = (id: string) => spaces.find((space) => space.id === id)?.name ?? 'a space';
  const listed = (contacts ?? []).filter((contact) => !contact.blocked);
  const blocked = (contacts ?? []).filter((contact) => contact.blocked);
  const asking = requests.length + knocks.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {error && (
        <div style={{ ...styles.errorBox, marginTop: 0 }}>
          <p style={styles.error}>{error}</p>
        </div>
      )}

      <KnockFromLink onKnock={(code, note) => act(() => node.doors.knock(code, note ? { note } : {}))} />

      {asking > 0 && (
        <section
          style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 16 }}
          aria-label="Asking to be your contact"
        >
          <h2 style={styles.sectionTitle}>Asking to be your contact</h2>
          <ul style={styles.todoList}>
            {requests.map((request) => (
              <li key={`${request.space}/${request.key}`} style={{ ...styles.row, alignItems: 'flex-start' }}>
                <Avatar did={request.from} size={32} />
                <div style={styles.todoContent}>
                  <p style={styles.todoText}>{request.name ?? nameOf(request.from, nobody)}</p>
                  <p style={styles.todoMeta}>
                    Asked in {spaceName(request.space)} · {ago(request.createdAt)}
                  </p>
                  {request.note && (
                    <p style={{ ...styles.todoMeta, color: palette.ink.body }}>“{request.note}”</p>
                  )}
                </div>
                <button
                  onClick={() => void act(() => node.contacts.accept(request.space, request.key))}
                  data-variant="primary"
                  style={{ ...styles.addButton, height: 32 }}
                >
                  Accept
                </button>
                <button
                  onClick={() => void act(() => node.contacts.block(request.from))}
                  data-variant="ghost"
                  style={styles.linkButton}
                  title="Hide their requests, in every space"
                >
                  Block
                </button>
              </li>
            ))}
            {knocks.map((knock) => (
              <li key={knock.id} style={{ ...styles.row, alignItems: 'flex-start' }}>
                <Avatar did={knock.from} size={32} />
                <div style={styles.todoContent}>
                  <p style={styles.todoText}>
                    {knock.name}{' '}
                    <span style={{ color: palette.ink.faint, fontWeight: 400 }}>
                      · {knock.from.slice(-6)}
                    </span>
                  </p>
                  <p style={styles.todoMeta}>
                    Knocked on {doorName(doors.find((door) => door.id === knock.door))} · {ago(knock.at)} ·
                    the name is theirs to choose; the code after it is who they are
                  </p>
                  {knock.note && (
                    <p style={{ ...styles.todoMeta, color: palette.ink.body }}>“{knock.note}”</p>
                  )}
                </div>
                <button
                  onClick={() => void act(() => node.doors.accept(knock.id))}
                  data-variant="primary"
                  style={{ ...styles.addButton, height: 32 }}
                >
                  Accept
                </button>
                <button
                  onClick={() => void act(() => node.doors.dismiss(knock.id))}
                  data-variant="ghost"
                  style={styles.linkButton}
                  title="Let this knock go; they can knock again"
                >
                  Dismiss
                </button>
                <button
                  onClick={() => void act(() => node.contacts.block(knock.from))}
                  data-variant="ghost"
                  style={styles.linkButton}
                  title="Hide their knocks and requests from now on"
                >
                  Block
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section style={{ display: 'flex', flexDirection: 'column', gap: 4 }} aria-label="Contacts">
        <h2 style={styles.sectionTitle}>Contacts{listed.length > 0 ? ` (${listed.length})` : ''}</h2>
        {contacts === undefined ? (
          <p style={styles.todoMeta}>Loading…</p>
        ) : listed.length === 0 ? (
          <div style={styles.emptyState}>
            No contacts yet. Add someone from a space you share — their name under People — or give them a
            link to one of your doors below.
          </div>
        ) : (
          <ul style={styles.todoList}>
            {listed.map((contact) => (
              <ContactRow key={contact.did} contact={contact} shared={writable} onOpen={onOpen} act={act} />
            ))}
          </ul>
        )}
        {sent.length > 0 && (
          <ul style={{ ...styles.todoList, marginTop: 4 }} aria-label="Knocks you left">
            {sent.map((knock) => (
              <li key={knock.space} style={{ ...styles.row, color: palette.ink.muted, fontSize: 13 }}>
                <span style={{ width: 32, textAlign: 'center' }} aria-hidden>
                  …
                </span>
                <span style={{ flex: 1 }}>
                  Waiting for{' '}
                  <strong style={{ color: palette.ink.strong, fontWeight: 500 }}>{knock.name}</strong> to open
                  their door · knocked {ago(knock.at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Doors doors={doors} act={act} />

      {blocked.length > 0 && (
        <details style={{ marginTop: 16 }}>
          <summary style={{ ...styles.todoMeta, cursor: 'pointer' }}>Blocked ({blocked.length})</summary>
          <ul style={{ ...styles.todoList, marginTop: 8 }}>
            {blocked.map((contact) => (
              <li key={contact.did} style={styles.row}>
                <Avatar did={contact.did} size={24} />
                <span style={{ flex: 1, fontSize: 14 }}>
                  {contact.name === contact.did ? nameOf(contact.did, nobody) : contact.name}
                </span>
                <button
                  onClick={() => void act(() => node.contacts.remove(contact.did))}
                  data-variant="ghost"
                  style={styles.linkButton}
                  title="They can ask or knock again"
                >
                  Unblock
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** A door by what you call it, or the name its code gives */
function doorName(door: DoorView | undefined): string {
  if (!door) return 'a door of yours';
  return door.label ? `“${door.label}”` : door.name ? `your door as ${door.name}` : 'your door';
}

/**
 * One contact: open your space for two, rename, remove or block. Warns when
 * someone other than the two of you is in that space — the invite was passed
 * on — so the person can decide whether it is still just the two of them.
 */
function ContactRow({
  contact,
  shared,
  onOpen,
  act,
}: {
  contact: ContactView;
  shared: ReadonlyArray<string>;
  onOpen: (spaceId: string) => void;
  act: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const node = useNode();
  const account = useAccount();
  const [others, setOthers] = useState<ReadonlyArray<string>>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const standing = useStanding(contact);

  useEffect(() => {
    let stopped = false;
    void node.contacts
      .others(contact.did)
      .then((found) => !stopped && setOthers(found))
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, [node, contact.did, contact.space]);

  const rename = () => {
    const name = renaming?.trim();
    setRenaming(null);
    if (name && name !== contact.name)
      void act(() =>
        node.contacts.put({
          did: contact.did,
          name,
          space: contact.space,
          ...(contact.note ? { note: contact.note } : {}),
        }),
      );
  };

  return (
    <li style={{ ...styles.row, alignItems: 'flex-start' }} title={contact.did}>
      <Avatar did={contact.did} size={32} />
      <div style={styles.todoContent}>
        {renaming === null ? (
          <p style={styles.todoText}>{contact.name}</p>
        ) : (
          <input
            value={renaming}
            onChange={(event) => setRenaming(event.target.value)}
            onBlur={rename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') rename();
              if (event.key === 'Escape') setRenaming(null);
            }}
            autoFocus
            maxLength={200}
            aria-label={`What you call ${contact.name}`}
            style={{ ...styles.input, height: 28, minHeight: 28, width: 200, padding: '0 8px', fontSize: 14 }}
          />
        )}
        <p style={styles.todoMeta}>
          {standing === 'waiting'
            ? 'Asked, waiting for them to accept'
            : standing === 'gone'
              ? 'You left your space for two: remove them to ask again'
              : contact.space
                ? 'Private space for the two of you'
                : 'No space for two yet'}{' '}
          · {contact.did.slice(-6)}
        </p>
        {others.length > 0 && (
          <p style={{ ...styles.todoMeta, color: palette.accent.danger }}>
            {others.length === 1 ? 'Someone else is' : `${others.length} others are`} in your space with{' '}
            {contact.name} ({others.map((did) => did.slice(-6)).join(', ')}): the invite was passed on.
          </p>
        )}
      </div>
      {contact.space && standing !== 'gone' && (
        <button onClick={() => onOpen(contact.space!)} data-variant="quiet" style={styles.smallButton}>
          Open
        </button>
      )}
      <button
        onClick={() => setRenaming(contact.name)}
        data-variant="ghost"
        style={styles.linkButton}
        title="Only you see what you call them"
      >
        Rename
      </button>
      <button
        onClick={() =>
          globalThis.confirm(
            standing === 'waiting'
              ? `Remove ${contact.name}? Your request is taken back and you leave the space for two.`
              : `Remove ${contact.name}? You leave the space for two; they keep their copy.`,
          ) && void act(() => takeBack(node, standing === 'waiting' ? shared : [], account.did, contact.did))
        }
        data-variant="ghost"
        style={styles.linkButton}
      >
        Remove
      </button>
      <button
        onClick={() =>
          globalThis.confirm(
            `Block ${contact.name}? You leave the space for two, and their requests and knocks are hidden from now on.`,
          ) && void act(() => node.contacts.block(contact.did))
        }
        data-variant="ghost"
        style={{ ...styles.linkButton, color: palette.accent.danger }}
      >
        Block
      </button>
    </li>
  );
}

/**
 * Your doors: links anyone can use to ask to become your contact, without
 * sharing a space with you first. Each has its own link, so one that gets
 * around too far can be closed without the others.
 */
function Doors({
  doors,
  act,
}: {
  doors: ReadonlyArray<DoorView>;
  act: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const node = useNode();
  const [opening, setOpening] = useState(false);
  const [knocking, setKnocking] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (door: DoorView) => {
    void globalThis.navigator.clipboard?.writeText(doorLink(door.code)).then(() => {
      setCopied(door.id);
      setTimeout(() => setCopied((id) => (id === door.id ? null : id)), 1500);
    });
  };

  return (
    <section style={{ ...styles.panelSection, marginTop: 24 }} aria-label="Your doors">
      <h2 style={styles.sectionTitle}>Your doors</h2>
      <p style={{ ...styles.todoMeta, marginTop: 0 }}>
        A door link lets someone you share no space with ask to become your contact. It says nothing about who
        you are; close it and it leads nowhere, while your contacts stay.
      </p>
      {doors.length > 0 && (
        <ul style={styles.todoList}>
          {doors.map((door) => (
            <li key={door.id} style={styles.row}>
              <div style={styles.todoContent}>
                <p style={styles.todoText}>{door.label ?? door.name ?? 'A door'}</p>
                <p style={styles.todoMeta}>
                  {door.name ? `Shows “${door.name}” to whoever knocks` : 'Shows no name'} · opened{' '}
                  {ago(door.createdAt)}
                </p>
              </div>
              <button onClick={() => copy(door)} data-variant="quiet" style={styles.smallButton}>
                {copied === door.id ? 'Copied' : 'Copy link'}
              </button>
              <button
                onClick={() => void act(() => node.doors.clear(door.id))}
                data-variant="ghost"
                style={styles.linkButton}
                title="Clear every knock waiting here, for a door someone is flooding"
              >
                Clear knocks
              </button>
              <button
                onClick={() =>
                  globalThis.confirm('Close this door? Its link stops working everywhere it was shared.') &&
                  void act(() => node.doors.close(door.id))
                }
                data-variant="ghost"
                style={{ ...styles.linkButton, color: palette.accent.danger }}
              >
                Close
              </button>
            </li>
          ))}
        </ul>
      )}
      <div style={styles.linkRow}>
        <button onClick={() => setOpening(true)} data-variant="quiet" style={styles.smallButton}>
          Open a door
        </button>
        <button onClick={() => setKnocking(true)} data-variant="ghost" style={styles.linkButton}>
          Knock on someone's door
        </button>
      </div>
      {opening && (
        <OpenDoor
          onClose={() => setOpening(false)}
          onOpen={(label, name) => {
            setOpening(false);
            void act(() => node.doors.open({ ...(label ? { label } : {}), ...(name ? { name } : {}) }));
          }}
        />
      )}
      {knocking && (
        <KnockDialog
          onClose={() => setKnocking(false)}
          onKnock={(code, note) => {
            setKnocking(false);
            void act(() => node.doors.knock(code, note ? { note } : {}));
          }}
        />
      )}
    </section>
  );
}

function OpenDoor({
  onClose,
  onOpen,
}: {
  onClose: () => void;
  onOpen: (label: string, name: string) => void;
}) {
  const [label, setLabel] = useState('');
  const [name, setName] = useState('');
  return (
    <Modal title="Open a door" onClose={onClose}>
      <form
        style={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          onOpen(label.trim(), name.trim());
        }}
      >
        <label style={styles.fieldLabel} htmlFor="door-label">
          What you call it — only you see this
        </label>
        <input
          id="door-label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          maxLength={64}
          placeholder="On my website"
          style={styles.input}
        />
        <label style={{ ...styles.fieldLabel, marginTop: 8 }} htmlFor="door-name">
          The name it shows whoever knocks — leave empty for your account's name
        </label>
        <input
          id="door-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={64}
          style={styles.input}
        />
        <button type="submit" data-variant="primary" style={{ ...styles.addButton, marginTop: 12 }}>
          Open door
        </button>
      </form>
    </Modal>
  );
}

function KnockDialog({
  initial = '',
  onClose,
  onKnock,
}: {
  initial?: string;
  onClose: () => void;
  onKnock: (code: string, note: string) => void;
}) {
  const [code, setCode] = useState(initial);
  const [note, setNote] = useState('');
  let problem: string | null = null;
  let name: string | null = null;
  if (code.trim()) {
    try {
      name = parseDoorCode(code).name ?? null;
    } catch (caught) {
      problem = caught instanceof Error ? caught.message : String(caught);
    }
  }
  return (
    <Modal title={name ? `Knock on ${name}'s door` : "Knock on someone's door"} onClose={onClose}>
      <form
        style={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          if (code.trim() && !problem) onKnock(code.trim(), note.trim());
        }}
      >
        {!initial && (
          <>
            <label style={styles.fieldLabel} htmlFor="door-code">
              Their door link or code
            </label>
            <input
              id="door-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              style={styles.input}
            />
            {problem && <p style={styles.bad}>{problem}</p>}
          </>
        )}
        <label style={{ ...styles.fieldLabel, marginTop: 8 }} htmlFor="knock-note">
          A note, so they know who is knocking
        </label>
        <textarea
          id="knock-note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={500}
          rows={3}
          style={{ ...styles.input, height: 'auto', padding: 10 }}
        />
        <p style={styles.todoMeta}>
          This makes a private space for the two of you and leaves its invite at their door. They see your
          account and the name you go by. The name a door shows is the owner's to choose, so be sure the link
          came from them.
        </p>
        <button
          type="submit"
          disabled={!code.trim() || !!problem}
          data-variant="primary"
          style={{ ...styles.addButton, marginTop: 12 }}
        >
          Knock
        </button>
      </form>
    </Modal>
  );
}

/** Offered when the page was opened from a door link: knock, or not now. */
function KnockFromLink({ onKnock }: { onKnock: (code: string, note: string) => Promise<void> }) {
  const [code, setCode] = useState(readDoorFromUrl);
  if (!code) return null;
  const done = () => {
    setCode(null);
    clearDoorFromUrl();
  };
  return (
    <KnockDialog
      initial={code}
      onClose={done}
      onKnock={(value, note) => {
        done();
        void onKnock(value, note);
      }}
    />
  );
}
