import { useState } from 'react';
import { useNode } from '@weaveprotocol/core/react';
import { Avatar } from '@weave/app-shared/Avatar';
import { Modal } from '@weave/app-shared/Modal';
import { SpaceHosting } from '@weave/app-shared/SpaceHosting';
import { SpaceBots } from '@weave/app-shared/CommunitySetup';
import type { Assembly, PartyFull } from './model';
import {
  EVERYTHING,
  PARTY_RULES,
  delegation,
  membership,
  party as partyCollection,
  type PartyRule,
} from './schema';
import { PARTY_RULE_LABEL, PartyChip, PartyMark, Problem, Who, decidesText } from './ui';
import { useAction } from '@weave/app-shared/action';
import { hue, palette } from './styles';

const HUES = [4, 28, 48, 110, 160, 200, 230, 265, 300, 335];

export function People({ a, writable }: { a: Assembly; writable: boolean }) {
  const [founding, setFounding] = useState(false);
  const [editing, setEditing] = useState<PartyFull | null>(null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
      <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <h2
              style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.04em', color: palette.ink.strong }}
            >
              Parties
            </h2>
            <p className="lq-muted" style={{ fontSize: 14, marginTop: 2 }}>
              People who vote together. Trust a party, and once more than half its members vote the same way,
              your device casts that vote for you.
            </p>
          </div>
          {writable && (
            <button className="lq-btn" data-variant="quiet" onClick={() => setFounding(true)}>
              Start a party
            </button>
          )}
        </div>
        {a.parties.length === 0 ? (
          <p className="lq-faint" style={{ fontSize: 13.5 }}>
            No parties yet. Everyone here stands for themselves.
          </p>
        ) : (
          <div className="lq-grid">
            {a.parties.map((p) => (
              <PartyCard key={p.key} a={a} p={p} writable={writable} onEdit={() => setEditing(p)} />
            ))}
          </div>
        )}
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.04em', color: palette.ink.strong }}>
            Members
          </h2>
          <p className="lq-muted" style={{ fontSize: 14, marginTop: 2 }}>
            Everyone who can vote. Trust someone with everything here, or topic by topic under Your vote.
          </p>
        </div>
        <div className="lq-card">
          {[...a.members]
            .sort((x, y) =>
              x.did === a.me ? -1 : y.did === a.me ? 1 : a.name(x.did).localeCompare(a.name(y.did)),
            )
            .map((m) => (
              <MemberRow key={m.did} a={a} did={m.did} role={m.role} writable={writable} />
            ))}
        </div>
      </section>

      <SpaceHosting spaceId={a.spaceId} writable={writable} />
      <SpaceBots spaceId={a.spaceId} writable={writable} />

      {founding && <PartyForm a={a} onClose={() => setFounding(false)} />}
      {editing && <PartyForm a={a} editing={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function MemberRow({
  a,
  did,
  role,
  writable,
}: {
  a: Assembly;
  did: string;
  role: string;
  writable: boolean;
}) {
  const node = useNode();
  const action = useAction();
  const trusted = a.delegations.filter((d) => d.kind === 'person' && d.to === did).length;
  const parties = a.parties.filter((p) => p.members.has(did));
  const mine = a.mine.find((d) => d.topic === EVERYTHING);
  const trustsThem = mine?.kind === 'person' && mine.to === did;
  const roleTitle = a.roles.find((r) => r.name === role)?.title ?? role;

  return (
    <div className="lq-row" style={{ flexWrap: 'wrap' }}>
      <Who did={did} a={a} size={32} />
      {role !== 'member' && <span className="lq-chip">{roleTitle}</span>}
      {parties.map((p) => (
        <PartyChip key={p.key} party={p} />
      ))}
      <span style={{ flex: 1 }} />
      {trusted > 0 && (
        <span className="lq-faint lq-num" style={{ fontSize: 12.5 }}>
          trusted {trusted}×
        </span>
      )}
      {writable && did !== a.me && (
        <button
          className="lq-btn"
          data-variant={trustsThem ? 'primary' : 'quiet'}
          data-size="sm"
          disabled={action.busy}
          title={
            trustsThem
              ? 'They vote for you on everything you haven’t given someone else. Click to stop.'
              : undefined
          }
          onClick={() =>
            void action.run(() =>
              trustsThem && mine
                ? node.records.delete(a.spaceId, mine.key)
                : node.records.put(a.spaceId, delegation, { kind: 'person', to: did, topic: EVERYTHING }),
            )
          }
        >
          {trustsThem ? 'Trusted with everything' : 'Trust with everything'}
        </button>
      )}
      <Problem>{action.error}</Problem>
    </div>
  );
}

function PartyCard({
  a,
  p,
  writable,
  onEdit,
}: {
  a: Assembly;
  p: PartyFull;
  writable: boolean;
  onEdit: () => void;
}) {
  const node = useNode();
  const action = useAction();
  const [requests, setRequests] = useState(false);
  const c = hue(p.hue);
  const steward = p.stewards.has(a.me);
  const myAsk = p.asked.get(a.me) ?? null;
  const inIt = p.members.has(a.me);
  const waiting = [...p.asked.keys()].filter(
    (did) => !p.members.has(did) && a.members.some((m) => m.did === did),
  );
  const trusted = a.delegations.filter((d) => d.kind === 'party' && d.to === p.key).length;

  const setMembers = (members: ReadonlyArray<string>) =>
    void action.run(() =>
      node.records.update(a.spaceId, p.key, {
        name: p.name,
        ...(p.platform ? { platform: p.platform } : {}),
        hue: p.hue,
        members: [...new Set([...p.stewards, ...members])],
        stewards: [...p.stewards],
        ...(a.current ? ruleBody(p.decides, p.representative) : {}),
      }),
    );

  return (
    <article
      className="lq-card"
      style={{
        padding: 18,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        borderTop: `3px solid ${c.strong}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <PartyMark party={p} size={36} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <p style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-0.02em', color: palette.ink.strong }}>
            {p.name}
          </p>
          <p className="lq-faint lq-num" style={{ fontSize: 12.5 }}>
            {p.members.size} {p.members.size === 1 ? 'member' : 'members'}
            {trusted ? ` · trusted by ${trusted}` : ''}
          </p>
          <p className="lq-muted lq-num" style={{ fontSize: 12.5 }}>
            Decides: {decidesText(a, p)}
          </p>
        </div>
        {steward && writable && (
          <button className="lq-btn" data-variant="ghost" data-size="sm" onClick={onEdit}>
            Edit
          </button>
        )}
      </div>
      {p.platform && (
        <p
          className="lq-muted"
          style={{
            fontSize: 13.5,
            lineHeight: 1.55,
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {p.platform}
        </p>
      )}
      <div className="lq-stack">
        {[...p.members].slice(0, 8).map((did) => (
          <Avatar key={did} did={did} size={22} />
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 'auto' }}>
        {writable &&
          (steward ? (
            <span className="lq-chip">You’re a steward</span>
          ) : inIt ? (
            <button
              className="lq-btn"
              data-variant="quiet"
              data-size="sm"
              disabled={action.busy}
              onClick={() => myAsk && void action.run(() => node.records.delete(a.spaceId, myAsk))}
            >
              Leave
            </button>
          ) : myAsk ? (
            <button
              className="lq-btn"
              data-variant="quiet"
              data-size="sm"
              disabled={action.busy}
              title="A steward lets members in"
              onClick={() => void action.run(() => node.records.delete(a.spaceId, myAsk))}
            >
              Asked · Cancel
            </button>
          ) : (
            <button
              className="lq-btn"
              data-size="sm"
              disabled={action.busy}
              onClick={() =>
                void action.run(() =>
                  node.records.put(a.spaceId, membership, {}, { links: [{ rel: 'about', to: p.key }] }),
                )
              }
            >
              Ask to join
            </button>
          ))}
        {steward && writable && waiting.length > 0 && (
          <button className="lq-btn" data-size="sm" onClick={() => setRequests((was) => !was)}>
            {waiting.length} asking to join
          </button>
        )}
      </div>
      {requests && steward && waiting.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            paddingTop: 10,
            borderTop: `1px solid ${palette.surface.line}`,
          }}
        >
          {waiting.map((did) => (
            <div key={did} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Who did={did} a={a} size={22} />
              <span style={{ flex: 1 }} />
              <button
                className="lq-btn"
                data-size="sm"
                disabled={action.busy}
                onClick={() => setMembers([...p.listed, did])}
              >
                Let in
              </button>
            </div>
          ))}
        </div>
      )}
      {p.decides === 'representative' && !(p.representative && p.members.has(p.representative)) && (
        <p className="lq-note" data-tone="warn" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
          Its representative isn’t a member, so it can’t take a position on new proposals. A steward picks
          another under Edit.
        </p>
      )}
      {steward && writable && p.stewards.size === 1 && (
        <p className="lq-note" data-tone="warn" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
          You’re its only steward. If you stop using Liquid, nobody can let people in or freeze its members
          for new proposals, and it can’t take a position again. Add a second steward under Edit.
        </p>
      )}
      <Problem>{action.error}</Problem>
    </article>
  );
}

function PartyForm({ a, editing, onClose }: { a: Assembly; editing?: PartyFull; onClose: () => void }) {
  const node = useNode();
  const [name, setName] = useState(editing?.name ?? '');
  const [platform, setPlatform] = useState(editing?.platform ?? '');
  const [shade, setShade] = useState(editing?.hue ?? HUES[a.parties.length % HUES.length] ?? 200);
  const [decides, setDecides] = useState<PartyRule>(editing?.decides ?? 'majority');
  const [representative, setRepresentative] = useState<string>(editing?.representative ?? a.me);
  const action = useAction();
  const members = editing ? [...editing.listed].filter((did) => did !== a.me) : [];
  const stewards = editing ? editing.stewards : new Set([a.me]);

  const save = (listed: ReadonlyArray<string>, keepers: ReadonlySet<string> = stewards) =>
    action.run(async () => {
      const body = {
        name: name.trim(),
        ...(platform.trim() ? { platform: platform.trim() } : {}),
        hue: shade,
        members: [...new Set([a.me, ...keepers, ...listed])],
        stewards: [...keepers],
        // An assembly from before parties chose keeps more than half.
        ...(a.current ? ruleBody(decides, representative) : {}),
      };
      if (editing) {
        await node.records.update(a.spaceId, editing.key, body);
      } else {
        const made = await node.records.put(a.spaceId, partyCollection, body);
        await node.records.put(a.spaceId, membership, {}, { links: [{ rel: 'about', to: made.key }] });
      }
      onClose();
    });
  const withSteward = (did: string, on: boolean) => {
    const next = new Set(stewards);
    if (on) next.add(did);
    else next.delete(did);
    return next;
  };

  return (
    <Modal title={editing ? `Edit ${editing.name}` : 'Start a party'} onClose={onClose} width={480}>
      <form
        style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) void save(editing ? [...editing.listed] : []);
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <PartyMark party={{ name: name || '?', hue: shade }} size={44} />
          <label className="lq-label" style={{ flex: 1 }}>
            Name
            <input
              className="lq-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="The Green Bench"
              maxLength={80}
              autoFocus
            />
          </label>
        </div>
        <div role="radiogroup" aria-label="Colour" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {HUES.map((h) => (
            <button
              key={h}
              type="button"
              role="radio"
              aria-checked={shade === h}
              aria-label={`Colour ${h}`}
              onClick={() => setShade(h)}
              style={{
                width: 26,
                height: 26,
                borderRadius: 8,
                border: 'none',
                background: hue(h).strong,
                boxShadow: shade === h ? `0 0 0 2px #fff, 0 0 0 4px ${hue(h).strong}` : 'none',
              }}
            />
          ))}
        </div>
        <label className="lq-label">
          What it stands for
          <textarea
            className="lq-textarea"
            value={platform}
            onChange={(event) => setPlatform(event.target.value)}
            placeholder="More green space, fewer car parks, and a budget everyone can read."
            maxLength={2000}
            style={{ minHeight: 96 }}
          />
        </label>
        {a.current && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <p className="lq-label">How it takes a position</p>
            <div
              style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}
              role="group"
              aria-label="How it decides"
            >
              {PARTY_RULES.map((rule) => (
                <button
                  key={rule}
                  type="button"
                  className="lq-chip"
                  data-filter
                  aria-pressed={decides === rule}
                  onClick={() => setDecides(rule)}
                >
                  {PARTY_RULE_LABEL[rule]}
                </button>
              ))}
            </div>
            {decides === 'representative' ? (
              <>
                <select
                  className="lq-input"
                  value={representative}
                  onChange={(event) => setRepresentative(event.target.value)}
                  aria-label="Representative"
                >
                  {[a.me, ...members].map((did) => (
                    <option key={did} value={did}>
                      {did === a.me ? `${a.name(did)} (you)` : a.name(did)}
                    </option>
                  ))}
                </select>
                <p className="lq-faint" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                  Their own vote on a proposal is the party’s, and everyone who trusts the party follows it. A
                  vote they cast by following someone doesn’t count.
                </p>
              </>
            ) : (
              <p className="lq-faint" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                It takes a position once{' '}
                {decides === 'everyone' ? 'all' : PARTY_RULE_LABEL[decides].toLowerCase()} of its members vote
                the same way themselves. Until then, nobody who trusts it votes by it.
              </p>
            )}
            <p className="lq-faint" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
              Changing this applies to proposals made from now on.
            </p>
          </div>
        )}
        {editing && members.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <p className="lq-label">Members</p>
            {members.map((did) => (
              <div key={did} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Who did={did} a={a} size={22} />
                {stewards.has(did) && <span className="lq-chip">Steward</span>}
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  className="lq-btn"
                  data-variant="ghost"
                  data-size="sm"
                  disabled={action.busy}
                  onClick={() => void save(members, withSteward(did, !stewards.has(did)))}
                >
                  {stewards.has(did) ? 'Not a steward' : 'Make steward'}
                </button>
                <button
                  type="button"
                  className="lq-btn"
                  data-variant="ghost"
                  data-size="sm"
                  disabled={action.busy || (decides === 'representative' && representative === did)}
                  title={
                    decides === 'representative' && representative === did
                      ? 'They’re its representative. Pick another first.'
                      : undefined
                  }
                  onClick={() =>
                    void save(
                      members.filter((m) => m !== did),
                      withSteward(did, false),
                    )
                  }
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
        {editing && stewards.size === 1 && (
          <p className="lq-faint" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
            Give it a second steward, so the party carries on if you stop using Liquid.
          </p>
        )}
        {!editing && (
          <p className="lq-faint" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
            You start it as its steward: you let people in, and your device freezes its members for each new
            proposal. Make other members stewards too, so it doesn’t depend on you alone.
          </p>
        )}
        <Problem>{action.error}</Problem>
        <div style={{ display: 'flex', gap: 8 }}>
          {editing && (
            <button
              type="button"
              className="lq-btn"
              data-variant="danger"
              disabled={action.busy}
              onClick={() => {
                if (
                  globalThis.confirm(
                    `Dissolve ${editing.name}? Everyone who trusts it will need to vote themselves, or trust someone else.`,
                  )
                )
                  void action.run(async () => {
                    await node.records.delete(a.spaceId, editing.key);
                    onClose();
                  });
              }}
            >
              Dissolve
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className="lq-btn" data-variant="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="lq-btn" disabled={!name.trim() || action.busy}>
            {action.busy ? 'Saving…' : editing ? 'Save' : 'Start party'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** A party's rule, as its body says it: a representative only when it decides by one */
function ruleBody(decides: PartyRule, representative: string | null) {
  return decides === 'representative' && representative ? { decides, representative } : { decides };
}
