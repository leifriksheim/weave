import { useEffect, useState, type ReactNode } from 'react';
import type { CarrierSummary, SpaceStatus } from '@weaveprotocol/core';
import { useAccount, useNetwork, useNode } from '@weaveprotocol/core/react';
import { healthOf, type Health } from '../derive/network';
import { Dot, HEALTH_COLOR } from './NetworkView';
import { nameOf, type People } from '../derive/people';
import { Avatar } from '@weave/app-shared/Avatar';
import { styles } from '../styles';

const count = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

/** Who this space is syncing with right now, by the accounts their connections proved, in a few words. */
export function WhoIsHere({
  status,
  people,
  onOpen,
}: {
  status: SpaceStatus;
  people: People;
  /** Opens the details: the Network tab */
  onOpen?: () => void;
}) {
  const node = useNode();
  const network = useNetwork();
  const { did: me } = useAccount();
  const [carriers, setCarriers] = useState<ReadonlyArray<CarrierSummary>>([]);
  const carrierKeys = status.carriers.join(',');
  useEffect(() => {
    if (!carrierKeys) return;
    void node.carriers
      .list()
      .then(setCarriers)
      .catch(() => {});
  }, [node, carrierKeys]);

  const health = healthOf(status, network);
  if (health !== 'syncing') {
    const reconnecting = network.relays.some((relay) => relay.openedAt !== null);
    const copy: Record<Exclude<Health, 'syncing'>, [string, string]> = {
      offline: [
        network.relays.length === 0 ? 'offline · no relay' : "offline · can't reach the relay",
        'Nothing leaves this device until a relay is reachable. Your changes are saved and go out then.',
      ],
      connecting: [
        reconnecting ? 'reconnecting…' : 'connecting…',
        'Finding the relay and the devices in this space',
      ],
      elsewhere: [
        'open in another tab',
        'This app is connected in another tab or window, and only one of them can be at a time. Close the other one and this one connects within a few seconds.',
      ],
      alone: [
        'online · no one else here',
        'The relay is reachable, but none of your other devices or the people in this space have it open right now',
      ],
    };
    const [label, why] = copy[health];
    return (
      <Badge onOpen={onOpen} title={why}>
        <Dot color={HEALTH_COLOR[health]} />
        <span>{label}</span>
      </Badge>
    );
  }

  const ownDevices = status.peers.filter(
    (peer) => status.own.includes(peer) || status.accounts[peer] === me,
  ).length;
  const others = status.peers.filter(
    (peer) => !status.own.includes(peer) && !status.carriers.includes(peer) && status.accounts[peer] !== me,
  );
  // One name per person, however many of their devices are here.
  const here = [
    ...new Set(others.map((peer) => status.accounts[peer]).filter((account): account is string => !!account)),
  ];
  const servers = others.filter((peer) => !status.accounts[peer]).length;
  const helpers = status.carriers.map((did) => carriers.find((c) => c.did === did)?.name ?? 'a carrier');
  // Short enough for a sidebar however many are here: who, or how many. The rest is in the tooltip.
  const short =
    here.length === 1
      ? nameOf(here[0], people)
      : here.length > 1
        ? `${here.length} people`
        : ownDevices > 0
          ? count(ownDevices, 'your other device', 'of your devices')
          : servers > 0
            ? count(servers, 'a server', 'servers')
            : helpers.length > 0
              ? 'kept online'
              : 'just you';

  return (
    <Badge
      onOpen={onOpen}
      title={[
        'Syncing directly with, right now:',
        ...here.map((did) => `• ${nameOf(did, people)}`),
        `• ${ownDevices} of your own devices or apps`,
        ...(servers > 0
          ? [`• ${servers} ${servers === 1 ? 'server' : 'servers'} that didn't say whose they are`]
          : []),
        `• ${status.carriers.length} ${status.carriers.length === 1 ? 'carrier' : 'carriers'}, keeping your spaces online without reading them${helpers.length ? ` (${helpers.join(', ')})` : ''}`,
        '',
        'Open Network for details',
      ].join('\n')}
    >
      {here.length > 0 ? (
        <span style={{ display: 'inline-flex' }} aria-hidden>
          {here.slice(0, 3).map((did, i) => (
            <span
              key={did}
              style={{
                marginLeft: i === 0 ? 0 : -5,
                borderRadius: 4,
                boxShadow: '0 0 0 1.5px #fff',
                display: 'inline-flex',
              }}
            >
              <Avatar did={did} size={14} />
            </span>
          ))}
        </span>
      ) : (
        <Dot color={HEALTH_COLOR.syncing} />
      )}
      <span style={ellipsis}>online · {short}</span>
    </Badge>
  );
}

const ellipsis = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 } as const;

/** The badge, which opens the Network tab when there is one to open */
function Badge({ onOpen, title, children }: { onOpen?: () => void; title: string; children: ReactNode }) {
  const style = { ...styles.badge, display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%' };
  if (!onOpen)
    return (
      <span style={style} title={title}>
        {children}
      </span>
    );
  return (
    <button
      type="button"
      onClick={onOpen}
      title={title}
      style={{ ...style, cursor: 'pointer', font: 'inherit', fontSize: 12 }}
    >
      {children}
    </button>
  );
}
