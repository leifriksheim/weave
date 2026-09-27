import { useEffect, useState } from 'react';
import { useAccount, useNode } from '@weaveprotocol/core/react';
import { styles } from '../styles';

/**
 * The name others see, asked where it matters: making or joining a space.
 *
 * Filled in with the account's name, so most people just carry on. Saving it
 * puts it on the account, and the node tells every space from there — so
 * nobody shows up as a bare code because they never got round to settings.
 */
export function useMyName() {
  const node = useNode();
  const account = useAccount();
  const [saved, setSaved] = useState<string | null>(null);
  const [name, setName] = useState(account.name);

  useEffect(() => {
    let live = true;
    void node.account.profile().then((profile) => {
      if (!live || !profile) return;
      setSaved(profile.name);
      setName((current) => (current === account.name ? profile.name : current));
    }).catch(() => {});
    return () => {
      live = false;
    };
  }, [node, account.name]);

  /** Keeps the name on the account, unless it is empty or already there */
  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === saved) return;
    await node.account.setName(trimmed).catch(() => {});
  };

  return { name, setName, save };
}

export function NameField({ value, onChange }: { value: string; onChange: (name: string) => void }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={styles.factLabel}>What should people call you?</span>
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Your name"
        maxLength={64}
        autoComplete="name"
        style={styles.input}
      />
    </label>
  );
}
