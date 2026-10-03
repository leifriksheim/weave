import { useState } from 'react';
import { rolePresets, type NewSpace, type SpaceSummary } from '@weaveprotocol/core';
import { useMyName, useNode } from '@weaveprotocol/core/react';
// Defines collections in a space; not a React hook, whatever its name says.
import { useSchemas as defineCollections } from '@weaveprotocol/core/schemas';
import { Modal, Choice } from '@weave/app-shared/Modal';
import { ASSEMBLY, topic } from './schema';
import { Problem, TopicPicker } from './ui';
import { useAction } from '@weave/app-shared/action';

/** Topics most groups start with; the person picks some, adds their own, or none */
const SUGGESTED: ReadonlyArray<{ name: string; hue: number }> = [
  { name: 'Budget', hue: 150 },
  { name: 'Events', hue: 28 },
  { name: 'Rules', hue: 262 },
  { name: 'Environment', hue: 110 },
  { name: 'Housing', hue: 205 },
  { name: 'Culture', hue: 330 },
];

/**
 * Makes an assembly: a space with Liquid's collections, the roles of a
 * community (admins, moderators, members), and its first topics.
 */
export function NewAssembly({
  onClose,
  create,
  onCreated,
}: {
  onClose: () => void;
  create: (params: NewSpace) => Promise<SpaceSummary | null>;
  onCreated: (id: string) => void;
}) {
  const node = useNode();
  const me = useMyName();
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [membersInvite, setMembersInvite] = useState(false);
  const [topics, setTopics] = useState<ReadonlyArray<{ name: string; hue: number }>>(SUGGESTED.slice(0, 3));
  const [custom, setCustom] = useState('');
  const action = useAction();

  const toggle = (t: { name: string; hue: number }) =>
    setTopics((was) =>
      was.some((x) => x.name === t.name) ? was.filter((x) => x.name !== t.name) : [...was, t],
    );
  const addCustom = () => {
    const trimmed = custom.trim();
    if (!trimmed || topics.some((t) => t.name.toLowerCase() === trimmed.toLowerCase())) return;
    setTopics((was) => [...was, { name: trimmed, hue: (was.length * 67 + 17) % 360 }]);
    setCustom('');
  };
  const all = [...SUGGESTED, ...topics.filter((t) => !SUGGESTED.some((s) => s.name === t.name))];

  const submit = () =>
    void action.run(async () => {
      await me.save();
      const roles = rolePresets.community.roles.map((role) =>
        role.name === 'member' && membersInvite ? { ...role, permissions: ['invite'] } : role,
      );
      const space = await create({ name: name.trim(), visibility, roles, creatorRole: 'admin' });
      if (!space) throw new Error('The assembly could not be made');
      await defineCollections(node, space.id, ASSEMBLY);
      for (const t of topics) await node.records.put(space.id, topic, { name: t.name, hue: t.hue });
      onCreated(space.id);
    });

  return (
    <Modal title="New assembly" onClose={onClose} width={480}>
      <form
        style={{ display: 'flex', flexDirection: 'column', gap: 18 }}
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() && me.name.trim()) submit();
        }}
      >
        <label className="lq-label">
          Name
          <input
            className="lq-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Riverside Housing Co-op"
            maxLength={80}
            autoFocus
          />
        </label>
        <label className="lq-label">
          Your name in it
          <input
            className="lq-input"
            value={me.name}
            onChange={(event) => me.setName(event.target.value)}
            placeholder="Your name"
            maxLength={64}
            autoComplete="name"
          />
        </label>
        <Choice
          label="Who can read it"
          value={visibility}
          onChange={setVisibility}
          options={[
            { value: 'private', label: 'Members only' },
            { value: 'public', label: 'Anyone with the link' },
          ]}
        />
        <div>
          <p className="lq-label" style={{ marginBottom: 8 }}>
            Topics
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <TopicPicker topics={all} on={(t) => topics.some((x) => x.name === t.name)} onToggle={toggle} />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input
              className="lq-input"
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addCustom();
                }
              }}
              placeholder="Add a topic"
              maxLength={60}
            />
            <button
              type="button"
              className="lq-btn"
              data-variant="quiet"
              onClick={addCustom}
              disabled={!custom.trim()}
            >
              Add
            </button>
          </div>
          <p className="lq-faint" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.5 }}>
            People can trust someone with one topic and someone else with another. Moderators can change these
            later.
          </p>
        </div>
        <label
          style={{
            display: 'flex',
            gap: 10,
            alignItems: 'flex-start',
            fontSize: 13.5,
            lineHeight: 1.5,
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={membersInvite}
            onChange={(event) => setMembersInvite(event.target.checked)}
            style={{ marginTop: 3, accentColor: '#000' }}
          />
          <span>
            Members can invite others
            <span className="lq-faint" style={{ display: 'block', fontSize: 12.5 }}>
              Every account is one vote, so whoever can invite decides who votes. Off, only you and moderators
              can.
            </span>
          </span>
        </label>
        <Problem>{action.error}</Problem>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="lq-btn" data-variant="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="lq-btn" disabled={action.busy || !name.trim() || !me.name.trim()}>
            {action.busy ? 'Creating…' : 'Create assembly'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
