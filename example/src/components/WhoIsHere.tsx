import { useEffect, useState } from 'react';
import type { CarrierSummary, SpaceStatus } from '@weaveprotocol/core';
import { useAccount, useNode } from '@weaveprotocol/core/react';
import { nameOf, type People } from '../derive/people';
import { Avatar } from './Avatar';
import { styles } from '../styles';

const count = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

/** "Anna", "Anna and Bob", "Anna, Bob and 3 more" */
function listed(names: ReadonlyArray<string>): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

/**
 * Who this space is syncing with right now, in words: the people here by
 * name, your own other devices, and carriers keeping it online — rather than
 * a count of "peers" that says nothing about whose they are. A peer's account
 * is the one its connection proved (`status.accounts`), so a name here is
 * someone actually connected, not someone claiming to be.
 */
export function WhoIsHere({ status, people }: { status: SpaceStatus; people: People }) {
  const node = useNode();
  const { did: me } = useAccount();
  const [carriers, setCarriers] = useState<ReadonlyArray<CarrierSummary>>([]);
  const carrierKeys = status.carriers.join(',');
  useEffect(() => {
    if (!carrierKeys) return;
    void node.carriers.list().then(setCarriers).catch(() => {});
  }, [node, carrierKeys]);

  if (status.connection === 'offline') return <span style={styles.badge}>○ offline</span>;
  if (status.connection === 'connecting') return <span style={styles.badge}>◌ connecting</span>;
  if (status.connection === 'error') return <span style={styles.badge} title="Can't reach the relay that introduces peers">○ no relay</span>;

  const ownDevices = status.peers.filter((peer) => status.own.includes(peer) || status.accounts[peer] === me).length;
  const others = status.peers.filter((peer) => !status.own.includes(peer) && !status.carriers.includes(peer) && status.accounts[peer] !== me);
  // One name per person, however many of their devices are here.
  const here = [...new Set(others.map((peer) => status.accounts[peer]).filter((account): account is string => !!account))];
  const servers = others.filter((peer) => !status.accounts[peer]).length;
  const helpers = status.carriers.map((did) => carriers.find((c) => c.did === did)?.name ?? 'a carrier');
  const parts = [
    here.length > 0 && listed(here.map((did) => nameOf(did, people))),
    ownDevices > 0 && count(ownDevices, 'your other device', 'of your devices'),
    servers > 0 && count(servers, 'a server', 'servers'),
    helpers.length > 0 && `kept online by ${helpers.join(', ')}`,
  ].filter(Boolean);

  return (
    <span
      style={{ ...styles.badge, display: 'inline-flex', alignItems: 'center', gap: 6 }}
      title={[
        'Syncing directly with, right now:',
        ...here.map((did) => `• ${nameOf(did, people)}`),
        `• ${ownDevices} of your own devices or apps`,
        ...(servers > 0 ? [`• ${servers} ${servers === 1 ? 'server' : 'servers'} that didn't say whose they are`] : []),
        `• ${status.carriers.length} ${status.carriers.length === 1 ? 'carrier' : 'carriers'}, keeping your spaces online without reading them`,
      ].join('\n')}
    >
      {here.length > 0 ? (
        <span style={{ display: 'inline-flex' }} aria-hidden>
          {here.slice(0, 3).map((did, i) => (
            <span key={did} style={{ marginLeft: i === 0 ? 0 : -5, borderRadius: 4, boxShadow: '0 0 0 1.5px #fff', display: 'inline-flex' }}>
              <Avatar did={did} size={14} />
            </span>
          ))}
        </span>
      ) : (
        '●'
      )}
      <span>online · {parts.length > 0 ? parts.join(' · ') : 'just you'}</span>
    </span>
  );
}
