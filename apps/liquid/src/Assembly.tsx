import { useState, type ReactNode } from 'react';
import type { SpaceSummary } from '@weaveprotocol/core';
import { inviteLink, useHoldSpace, useNode } from '@weaveprotocol/core/react';
import { Avatar } from '@weave/app-shared/Avatar';
import { Modal } from '@weave/app-shared/Modal';
import { useAssembly, type Assembly } from './model';
import { Proposals } from './Proposals';
import { Delegations } from './Delegations';
import { People } from './People';
import { ASSEMBLY, topic as topicCollection } from './schema';
import { Problem, TopicChip } from './ui';
import { useAction, useCopy } from '@weave/app-shared/action';
import { useDuties } from './duties';
import { palette } from './styles';
import { CommunitySetup } from '@weave/app-shared/CommunitySetup';

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

  const open = a.proposals.filter((p) => p.result === 'open').length;
  useDuties(a, space.writable);
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
          {!a.current && <Outdated a={a} writable={space.writable} />}
          {tab === 'proposals' && <CommunitySetup spaceId={a.spaceId} writable={space.writable} />}
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

/**
 * An assembly made by an older Liquid: votes there could change, and
 * proposals had no voter list. Someone allowed to change the space's
 * collections brings it up to date; proposals made before stay undecided.
 */
function Outdated({ a, writable }: { a: Assembly; writable: boolean }) {
  const node = useNode();
  const action = useAction();
  return (
    <div className="lq-note" data-tone="warn" style={{ marginBottom: 20, fontSize: 13, lineHeight: 1.55 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span>
          This assembly was made with an older Liquid, where votes could change and proposals closed by hand.
          Updating it makes votes final and proposals settle themselves. Proposals made before stay as they
          are.
        </span>
        {writable && (
          <button
            className="lq-btn"
            data-size="sm"
            style={{ alignSelf: 'flex-start' }}
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                for (const definition of ASSEMBLY) await node.collections.define(a.spaceId, definition);
              })
            }
          >
            Update this assembly
          </button>
        )}
        <Problem>{action.error}</Problem>
      </div>
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
  const { copied, copy } = useCopy(1600);
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
            <button className="lq-btn" onClick={() => copy(link)}>
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
          Each proposal lists who votes on it: everyone in the assembly when it was proposed. People who join
          later vote on later proposals.
        </Li>
        <Li>
          <strong>Votes are final.</strong> Once cast, a vote can’t be changed or taken back. That’s what lets
          a result, once reached, stay reached.
        </Li>
        <Li>
          When you don’t vote, your device follows whoever you trust with the proposal’s topic, or else
          whoever you trust with everything: once they vote, it casts the same vote for you, signed by you.
          Vote first and your own vote counts instead.
        </Li>
        <Li>
          Following goes along a chain, one device at a time: if you trust Ada and Ada trusts Bo, Bo’s vote
          reaches Ada first, then you. A chain that loops back round never casts anything; Liquid warns you.
        </Li>
        <Li>
          A party takes a position once more than half of its members vote the same way themselves. Its
          stewards’ devices freeze who its members are for each proposal.
        </Li>
      </Section>
      <Section title="How a proposal is settled">
        <Li>
          <strong>Passed</strong> once more than half of its voters voted for. <strong>Rejected</strong> once
          at least half voted against or abstained, so for can no longer pass.
        </Li>
        <Li>
          Whichever device sees that first writes a decision citing the votes, and every device checks it.
          Nobody closes a vote and nobody adds up, so every device reaches the same result, in any order.
        </Li>
        <Li>
          <strong>Disputed</strong> when someone is caught signing two different versions of a vote, or a
          party’s members. That proof spreads like any record, and no later vote takes it back.
        </Li>
      </Section>
      <Section title="What this app can’t promise">
        <Li>
          <strong>A proposal can stay open.</strong> There’s no deadline: devices don’t share a trusted clock.
          If too few people vote, it stays open.
        </Li>
        <Li>
          <strong>Following needs a device.</strong> Your vote follows your delegate only while Liquid is open
          on one of your devices.
        </Li>
        <Li>
          <strong>Votes are not secret.</strong> Everyone in the assembly can see who voted what, and who
          trusts whom. That’s how delegates stay accountable, but it rules out a secret ballot.
        </Li>
        <Li>
          <strong>Someone writes the voter list.</strong> Whoever proposes lists the members their device
          knows of. Every voter must be a member, but nothing proves nobody was left out.
        </Li>
        <Li>
          <strong>One account, one vote.</strong> Nothing proves an account is a different person. Whoever can
          invite decides who votes, so invite with care.
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
