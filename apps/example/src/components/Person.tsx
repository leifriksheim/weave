import { createContext, useContext, useState, type ReactNode } from 'react';
import type { ContactView, SpaceSummary } from '@weaveprotocol/core';
import { useNode } from '@weaveprotocol/core/react';
import { styles, palette } from '../styles';
import { nameOf, type People } from '../derive/people';
import { takeBack, useContacts, useStanding } from '../contacts';
import { Avatar } from '@weave/app-shared/Avatar';
import { Modal } from '@weave/app-shared/Modal';

/** What a name in a space needs to open its card: the space, who is in it, and where a space for two opens */
interface PersonScope {
  readonly space: SpaceSummary;
  readonly people: People;
  readonly roles: ReadonlyMap<string, string>;
  readonly me: string;
  readonly openSpace?: (id: string) => void;
}

const Scope = createContext<PersonScope | null>(null);

/** Set once by the space on screen, so every name inside it can be clicked without being handed the space */
export function PersonScopeProvider({ children, ...scope }: PersonScope & { children: ReactNode }) {
  return <Scope.Provider value={scope}>{children}</Scope.Provider>;
}

/** Who is in the space on screen, and which of them is you: null outside a space */
export function usePeopleHere(): { readonly people: People; readonly me: string } | null {
  const scope = useContext(Scope);
  return scope ? { people: scope.people, me: scope.me } : null;
}

/**
 * Someone's name, which opens their card. Outside a space there is no card
 * to open, so it is only the name.
 */
export function Person({
  did,
  suffix,
  style,
}: {
  did: string | null | undefined;
  suffix?: string;
  style?: React.CSSProperties;
}) {
  const scope = useContext(Scope);
  const [open, setOpen] = useState(false);
  const name = nameOf(did, scope?.people ?? new Map());
  if (!scope || !did)
    return (
      <span style={style}>
        {name}
        {suffix}
      </span>
    );
  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          // Names sit inside rows that open records; this click is for the person.
          event.stopPropagation();
          setOpen(true);
        }}
        title={did}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          font: 'inherit',
          color: 'inherit',
          cursor: 'pointer',
          textDecoration: 'underline',
          textDecorationColor: palette.surface.line,
          textUnderlineOffset: 3,
          ...style,
        }}
      >
        {name}
        {suffix}
      </button>
      {open && <PersonCard did={did} scope={scope} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * Who someone is here, and whether they can be a contact. Says why not when
 * they can't, since the + that used to be the only way in gave no reason.
 */
function PersonCard({ did, scope, onClose }: { did: string; scope: PersonScope; onClose: () => void }) {
  const { space, people, roles, me } = scope;
  const contacts = useContacts();
  const [copied, setCopied] = useState(false);
  // Asking puts them on the list at once, which would swap the confirmation for "In your contacts".
  const [asked, setAsked] = useState(false);
  const name = nameOf(did, people);
  const profile = people.get(did);
  const contact = contacts?.find((c) => c.did === did);
  const role = roles.get(did);

  const copy = () =>
    void globalThis.navigator.clipboard?.writeText(did).then(() => {
      setCopied(true);
      globalThis.setTimeout(() => setCopied(false), 1500);
    });

  return (
    <Modal title={name} onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <Avatar did={did} size={48} />
        <div style={{ minWidth: 0 }}>
          <p style={{ fontSize: 13, color: palette.ink.muted }}>
            {did === me ? 'You' : profile ? `In ${space.name}` : `No profile in ${space.name}`}
            {role && ` · ${role.toLowerCase()}`}
          </p>
          <p style={{ ...styles.todoMeta, fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all' }}>
            {did}{' '}
            <button
              type="button"
              onClick={copy}
              data-variant="ghost"
              style={{ ...styles.linkButton, padding: '0 4px', fontSize: 12 }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </p>
        </div>
      </div>
      {did === me ? null : asked ? (
        <>
          <p style={styles.hint}>
            Asked. {name} is on your contacts now, and will see your request here in {space.name}. Once they
            accept, the two of you share a private space.
          </p>
          <button onClick={onClose} data-variant="primary" style={styles.addButton}>
            Done
          </button>
        </>
      ) : contacts === undefined ? (
        <p style={styles.hint}>Loading your contacts…</p>
      ) : contact?.blocked ? (
        <p style={styles.hint}>You blocked {name}. Unblock them from Contacts to hear from them again.</p>
      ) : contact ? (
        <Standing contact={contact} name={name} scope={scope} onClose={onClose} />
      ) : !profile?.contactKey ? (
        <p style={styles.hint}>
          {name} can't be added as a contact yet: the app they use here wasn't given their contacts, so there
          is no key to seal a request to.
        </p>
      ) : !space.writable ? (
        <p style={styles.hint}>
          You can only read {space.name}, so you can't leave a request for {name} here.
        </p>
      ) : (
        <AskContact space={space} did={did} name={name} onAsked={() => setAsked(true)} />
      )}
    </Modal>
  );
}

/**
 * Someone already on your list: whether they have joined your space for two
 * yet, and what to do when they haven't, or when you left it.
 */
function Standing({
  contact,
  name,
  scope,
  onClose,
}: {
  contact: ContactView;
  name: string;
  scope: PersonScope;
  onClose: () => void;
}) {
  const node = useNode();
  const standing = useStanding(contact);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { space, me, openSpace } = scope;
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
    setBusy(false);
  };
  const called = contact.name !== name && contact.name !== contact.did ? ` as ${contact.name}` : '';

  if (standing === undefined) return <p style={styles.hint}>Loading…</p>;
  if (standing === 'gone') {
    return (
      <>
        <p style={styles.hint}>
          You left your space for two with {name}, so they are on your list{called} but you no longer share
          anything. Remove them to ask again.
        </p>
        {error && <p style={styles.bad}>{error}</p>}
        <button
          disabled={busy}
          onClick={() => void act(() => takeBack(node, [space.id], me, contact.did))}
          data-variant="primary"
          style={styles.addButton}
        >
          {busy ? 'Removing…' : 'Remove, and ask again'}
        </button>
      </>
    );
  }
  if (standing === 'waiting') {
    return (
      <>
        <p style={styles.hint}>
          You asked {name}. Waiting for them to accept; they see your request in {space.name} and on their
          Contacts screen.
        </p>
        {error && <p style={styles.bad}>{error}</p>}
        <button
          disabled={busy}
          onClick={() =>
            globalThis.confirm(
              `Take back your request to ${name}? Your space for two is left and the request here is deleted.`,
            ) && void act(() => takeBack(node, [space.id], me, contact.did))
          }
          data-variant="quiet"
          style={styles.smallButton}
        >
          {busy ? 'Taking back…' : 'Take back'}
        </button>
      </>
    );
  }
  return (
    <>
      <p style={styles.hint}>In your contacts{called}.</p>
      {contact.space && openSpace && (
        <button
          onClick={() => {
            onClose();
            openSpace(contact.space!);
          }}
          data-variant="primary"
          style={styles.addButton}
        >
          Open your space for two
        </button>
      )}
    </>
  );
}

/**
 * Asking someone here to become a contact: a private space for the two of you,
 * its invite posted in this space sealed so only they can open it. Everyone
 * here can see that you asked them, not what you wrote.
 */
function AskContact({
  space,
  did,
  name,
  onAsked,
}: {
  space: SpaceSummary;
  did: string;
  name: string;
  onAsked: () => void;
}) {
  const node = useNode();
  const [note, setNote] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ask = async () => {
    setAsking(true);
    setError(null);
    try {
      await node.contacts.ask(space.id, did, note.trim() ? { note: note.trim() } : {});
      onAsked();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setAsking(false);
    }
  };
  return (
    <form
      style={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        void ask();
      }}
    >
      <p style={{ ...styles.todoMeta, marginTop: 0 }}>
        Adding {name} makes a private space for the two of you and leaves its invite here, sealed so only they
        can open it. Others in {space.name} see that you asked, not what you wrote.
      </p>
      <label style={{ ...styles.fieldLabel, marginTop: 8 }} htmlFor="ask-note">
        A note (optional)
      </label>
      <textarea
        id="ask-note"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        maxLength={2000}
        rows={3}
        style={{ ...styles.input, height: 'auto', padding: 10 }}
      />
      {error && <p style={styles.bad}>{error}</p>}
      <button
        type="submit"
        disabled={asking}
        data-variant="primary"
        style={{ ...styles.addButton, marginTop: 12 }}
      >
        {asking ? 'Asking…' : 'Add as a contact'}
      </button>
    </form>
  );
}
