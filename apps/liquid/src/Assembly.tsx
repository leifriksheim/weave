import { useState, type ReactNode } from 'react';
import type { SpaceSummary } from '@weaveprotocol/core';
import { inviteLink, useHoldSpace, useNode } from '@weaveprotocol/core/react';
import { Avatar } from '@weave/app-shared/Avatar';
import { Modal } from '@weave/app-shared/Modal';
import { useAssembly, type Assembly } from './model';
import { Proposals } from './Proposals';
import { Delegations } from './Delegations';
import { People } from './People';
import { topic as topicCollection } from './schema';
import { Problem, TopicChip, useAction } from './ui';
import { palette } from './styles';

type Tab = 'proposals' | 'trust' | 'people';

/** Whether this browser has seen how Liquid works, so it opens by itself only the first time */
const SEEN_KEY = 'liquid:seen-how';
const seenHow = () => {
  try {
    return globalThis.localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return true;
  }
};

/** The standalone shell: back to the list, the name, who is here, invites. The assembly itself below. */
export function AssemblyView({ space, onBack }: { space: SpaceSummary; onBack: () => void }) {
  useHoldSpace(space.id);
  const a = useAssembly(space.id);
  const [inviting, setInviting] = useState(false);

  return (
    <div className="lq-shell">
      <header className="lq-header">
        <div className="lq-header-inner lq-bar">
          <button
            className="lq-icon-btn"
            onClick={onBack}
            aria-label="Your assemblies"
            title="Your assemblies"
          >
            ←
          </button>
          <p
            style={{
              minWidth: 0,
              flex: 1,
              fontSize: 16,
              fontWeight: 600,
              letterSpacing: '-0.025em',
              color: palette.ink.strong,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {space.name}
          </p>
          <span className="lq-stack lq-hide-phone" title="Who is here">
            {a.members.slice(0, 5).map((m) => (
              <Avatar key={m.did} did={m.did} size={24} />
            ))}
          </span>
          {a.mayInvite && space.writable && (
            <button className="lq-btn" data-size="sm" onClick={() => setInviting(true)}>
              Invite
            </button>
          )}
        </div>
      </header>
      <main className="lq-main">
        <AssemblyBody space={space} a={a} />
      </main>
      {inviting && <Invite a={a} onClose={() => setInviting(false)} />}
    </div>
  );
}

/**
 * One assembly, as a host shows it in its own frame (`app.tsx`): the host
 * brings the space's name, its members and its invites.
 */
export function AssemblySpace({ space }: { space: SpaceSummary }) {
  return <AssemblyBody space={space} a={useAssembly(space.id)} />;
}

/** The tabs, and what each shows: the same standalone and inside a host */
function AssemblyBody({ space, a }: { space: SpaceSummary; a: Assembly }) {
  const [tab, setTab] = useState<Tab>('proposals');
  const [how, setHow] = useState(() => !seenHow());
  const [topics, setTopics] = useState(false);

  const closeHow = () => {
    setHow(false);
    try {
      globalThis.localStorage.setItem(SEEN_KEY, '1');
    } catch {
      // Only the "first time" memory is lost.
    }
  };

  const open = a.proposals.filter((p) => !p.closed).length;
  const mine = a.mine.length;

  return (
    <div className="lq-space">
      <div className="lq-tabbar">
        <nav className="lq-tabs" role="tablist" aria-label="Assembly">
          <TabButton id="proposals" tab={tab} onPick={setTab} count={open}>
            Proposals
          </TabButton>
          <TabButton id="trust" tab={tab} onPick={setTab} count={mine || undefined}>
            Your vote
          </TabButton>
          <TabButton id="people" tab={tab} onPick={setTab} count={a.members.length}>
            People
          </TabButton>
        </nav>
        <span style={{ flex: 1 }} />
        {a.mayModerate && (
          <button
            className="lq-btn lq-hide-phone"
            data-variant="ghost"
            data-size="sm"
            onClick={() => setTopics(true)}
          >
            Topics
          </button>
        )}
        <button
          className="lq-icon-btn"
          style={{ width: 28, height: 28, fontSize: 13 }}
          onClick={() => setHow(true)}
          aria-label="How Liquid works"
          title="How it works"
        >
          ?
        </button>
      </div>

      {space.joining ? (
        <Waiting />
      ) : !a.ready ? (
        <p className="lq-faint lq-fade">Loading…</p>
      ) : (
        <>
          {!space.writable && (
            <div className="lq-note" style={{ marginBottom: 20 }}>
              You can read this assembly, but you hold no role in it, so you can’t vote, propose or delegate.
            </div>
          )}
          {tab === 'proposals' && <Proposals a={a} writable={space.writable} />}
          {tab === 'trust' && <Delegations a={a} writable={space.writable} />}
          {tab === 'people' && <People a={a} writable={space.writable} />}
        </>
      )}

      {how && <HowItWorks onClose={closeHow} />}
      {topics && <Topics a={a} onClose={() => setTopics(false)} />}
    </div>
  );
}

function TabButton({
  id,
  tab,
  onPick,
  count,
  children,
}: {
  id: Tab;
  tab: Tab;
  onPick: (tab: Tab) => void;
  count?: number;
  children: ReactNode;
}) {
  return (
    <button className="lq-tab" role="tab" aria-selected={tab === id} onClick={() => onPick(id)}>
      {children}
      {count !== undefined && <span className="lq-tab-count">{count}</span>}
    </button>
  );
}

function Waiting() {
  return (
    <div className="lq-empty lq-fade">
      <p style={{ fontSize: 15, fontWeight: 600 }}>Joining…</p>
      <p style={{ fontSize: 13.5, maxWidth: 380, lineHeight: 1.55 }}>
        Your invite is on its way to the assembly. It opens as soon as someone who is already in it comes
        online.
      </p>
    </div>
  );
}

/** A link for someone new: as a member, who votes */
function Invite({ a, onClose }: { a: Assembly; onClose: () => void }) {
  const node = useNode();
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const action = useAction();
  const make = () =>
    void action.run(async () => {
      setLink(inviteLink(await node.spaces.invite(a.spaceId, { role: 'member' })));
    });

  return (
    <Modal title="Invite someone" onClose={onClose} width={440}>
      <p className="lq-muted" style={{ fontSize: 13.5, lineHeight: 1.55 }}>
        Anyone who opens this link joins as a member: they can vote, propose, delegate and be trusted. Each
        account is one vote, so send it only to people who belong here.
      </p>
      {link ? (
        <>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="lq-input"
              readOnly
              value={link}
              onFocus={(event) => event.target.select()}
              aria-label="Invite link"
            />
            <button
              className="lq-btn"
              onClick={() =>
                void globalThis.navigator.clipboard.writeText(link).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1600);
                })
              }
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="lq-faint" style={{ fontSize: 12, lineHeight: 1.5 }}>
            The link carries the key to the assembly in the part after #, which browsers never send to a
            server. Anyone who has it can join, so treat it like a key.
          </p>
        </>
      ) : (
        <button className="lq-btn" onClick={make} disabled={action.busy}>
          {action.busy ? 'Making a link…' : 'Make an invite link'}
        </button>
      )}
      <Problem>{action.error}</Problem>
    </Modal>
  );
}

/** Moderators set what proposals are sorted into, and what delegations can be limited to */
function Topics({ a, onClose }: { a: Assembly; onClose: () => void }) {
  const node = useNode();
  const [name, setName] = useState('');
  const action = useAction();
  const inUse = (key: string) =>
    a.proposals.some((p) => p.topic === key) || a.delegations.some((d) => d.topic === key);
  return (
    <Modal title="Topics" onClose={onClose} width={440}>
      <p className="lq-muted" style={{ fontSize: 13.5, lineHeight: 1.55 }}>
        Every proposal belongs to one topic, and people can trust someone with just that topic.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {a.topics.map((t) => (
          <div key={t.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <TopicChip topic={t} />
            <span style={{ flex: 1 }} />
            <button
              className="lq-btn"
              data-variant="ghost"
              data-size="sm"
              disabled={action.busy}
              title={
                inUse(t.key) ? 'Proposals or delegations use it: they would lose their topic' : undefined
              }
              onClick={() => {
                if (
                  !inUse(t.key) ||
                  globalThis.confirm(`Remove ${t.name}? Proposals and delegations on it lose their topic.`)
                )
                  void action.run(() => node.records.delete(a.spaceId, t.key));
              }}
            >
              Remove
            </button>
          </div>
        ))}
        {a.topics.length === 0 && <p className="lq-faint">No topics yet.</p>}
      </div>
      <form
        style={{ display: 'flex', gap: 8 }}
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = name.trim();
          if (!trimmed) return;
          void action
            .run(() =>
              node.records.put(a.spaceId, topicCollection, {
                name: trimmed,
                hue: (a.topics.length * 67 + 17) % 360,
              }),
            )
            .then((done) => done && setName(''));
        }}
      >
        <input
          className="lq-input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="New topic"
          maxLength={60}
        />
        <button className="lq-btn" disabled={!name.trim() || action.busy}>
          Add
        </button>
      </form>
      <Problem>{action.error}</Problem>
    </Modal>
  );
}

/**
 * How the count works, and what this app can't promise. Opens by itself the
 * first time, and from the ? in the header after that.
 */
function HowItWorks({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="How Liquid works" onClose={onClose} width={560}>
      <Section title="Your vote">
        <Li>
          Vote on any proposal yourself, any time before it closes. Your own vote always counts over a
          delegation.
        </Li>
        <Li>
          When you don’t vote, your vote goes to whoever you trust with the proposal’s topic, or else whoever
          you trust with everything.
        </Li>
        <Li>If they didn’t vote either, it goes on to whoever they trust, and so on.</Li>
        <Li>
          A party votes the way most of its members voted themselves. A tie, or no member voting, casts
          nothing. A party never passes your vote on further.
        </Li>
        <Li>
          A chain that loops back round, or ends with someone who did nothing, casts nothing. Liquid shows you
          when yours does.
        </Li>
        <Li>
          A proposal is accepted with more votes for than against. Abstaining counts toward turnout only.
        </Li>
      </Section>
      <Section title="What this app can’t promise">
        <Li>
          <strong>Votes are not secret.</strong> Everyone in the assembly can see who voted what, and who
          trusts whom. That’s how delegates stay accountable, but it rules out a secret ballot.
        </Li>
        <Li>
          <strong>Every device counts for itself.</strong> There is no server adding up. Each device runs the
          same rules on the votes it holds, so two devices can briefly disagree while votes are still
          arriving.
        </Li>
        <Li>
          <strong>Closing is one person’s snapshot.</strong> Whoever closes a proposal saves the count their
          device made. Everyone else sees whether their own count agrees. Nothing stops a vote being changed
          after closing; Liquid just stops showing the buttons, and the difference shows.
        </Li>
        <Li>
          <strong>There are no deadlines.</strong> Devices don’t share a trusted clock, so a proposal is open
          until someone closes it.
        </Li>
        <Li>
          <strong>One account, one vote.</strong> Nothing proves an account is a different person. Whoever can
          invite decides who votes, so invite with care.
        </Li>
        <Li>
          <strong>People who leave stop counting.</strong> The count only includes current members, as voters
          and as delegates.
        </Li>
        <Li>
          <strong>Liquid on its own asks for your whole Weave account.</strong> Making or joining an assembly
          after connecting needs it. It only shows the spaces that are assemblies.
        </Li>
        <Li>
          <strong>Private isn’t invisible.</strong> In a private assembly nobody outside can read the votes,
          but someone holding the encrypted copies can still tell who voted on which proposal.
        </Li>
      </Section>
      <button className="lq-btn" onClick={onClose} style={{ alignSelf: 'flex-end' }}>
        Got it
      </button>
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p className="lq-section-title">{title}</p>
      <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</ul>
    </section>
  );
}

function Li({ children }: { children: ReactNode }) {
  return (
    <li style={{ display: 'flex', gap: 10, fontSize: 13.5, lineHeight: 1.55, color: palette.ink.body }}>
      <span aria-hidden style={{ color: palette.ink.faint, flexShrink: 0 }}>
        –
      </span>
      <span>{children}</span>
    </li>
  );
}
