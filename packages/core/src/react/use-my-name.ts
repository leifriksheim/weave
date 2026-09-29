import { useEffect, useState } from 'react';
import { useAccount, useNode } from './context.js';

/**
 * The name others see, for asking where it matters: making or joining a
 * space. Starts as the account's name, so most people just carry on. `save`
 * puts it on the account, and the node tells every space from there, so
 * nobody shows up as a bare code because they never got round to settings.
 */
export function useMyName(): { name: string; setName: (name: string) => void; save: () => Promise<void> } {
  const node = useNode();
  const account = useAccount();
  const [saved, setSaved] = useState<string | null>(null);
  const [name, setName] = useState(account.name);

  useEffect(() => {
    let live = true;
    void node.account
      .profile()
      .then((profile) => {
        if (!live || !profile) return;
        setSaved(profile.name);
        setName((current) => (current === account.name ? profile.name : current));
      })
      .catch(() => {});
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
