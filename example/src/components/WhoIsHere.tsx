import { useEffect, useState } from 'react';
import type { CarrierSummary, SpaceStatus } from 'weave-protocol';
import { useNode } from 'weave-protocol/react';
import { styles } from '../styles';

const count = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

/**
 * Who this space is syncing with right now, in words: your own other devices,
 * other people, and carriers keeping it online — rather than a count of
 * "peers" that says nothing about whose they are.
 */
export function WhoIsHere({ status }: { status: SpaceStatus }) {
  const node = useNode();
  const [carriers, setCarriers] = useState<ReadonlyArray<CarrierSummary>>([]);
  const carrierKeys = status.carriers.join(',');
  useEffect(() => {
    if (!carrierKeys) return;
    void node.carriers.list().then(setCarriers).catch(() => {});
  }, [node, carrierKeys]);

  if (status.connection === 'offline') return <span style={styles.badge}>○ offline</span>;
  if (status.connection === 'connecting') return <span style={styles.badge}>◌ connecting</span>;
  if (status.connection === 'error') return <span style={styles.badge} title="Can't reach the relay that introduces peers">○ no relay</span>;

  const others = status.peers.length - status.own.length - status.carriers.length;
  const helpers = status.carriers.map((did) => carriers.find((c) => c.did === did)?.name ?? 'a carrier');
  const parts = [
    status.own.length > 0 && count(status.own.length, 'your other device', 'of your devices'),
    others > 0 && count(others, 'someone else', 'others'),
    helpers.length > 0 && `kept online by ${helpers.join(', ')}`,
  ].filter(Boolean);

  return (
    <span
      style={styles.badge}
      title={[
        'Syncing directly with, right now:',
        `• ${status.own.length} of your own devices or apps`,
        `• ${others} other — someone else's device, or a server`,
        `• ${status.carriers.length} ${status.carriers.length === 1 ? 'carrier' : 'carriers'}, keeping your spaces online without reading them`,
      ].join('\n')}
    >
      ● online · {parts.length > 0 ? parts.join(' · ') : 'just you'}
    </span>
  );
}
