import { relayOnlyLocal, relayProblem } from '@weave/app-shared/relay';
import { useNetwork, useNode } from '@weaveprotocol/core/react';
import { CLOSE_DID_TAKEN } from '@weaveprotocol/core';
import { duration, nextRetry } from '../derive/network';
import { styles } from '../styles';
import { useNow } from './NetworkView';

/** Says when no relay is reachable, since otherwise nothing syncs and nothing says why */
export function RelayNotice() {
  const problem = relayProblem();
  if (problem) {
    return (
      <div style={styles.errorBox}>
        <p style={styles.error}>Peers cannot find each other</p>
        <p style={styles.errorHint}>{problem}</p>
        <p style={styles.errorHint}>
          Your spaces still work, and still save. They just will not reach your other devices until this is
          set.
        </p>
      </div>
    );
  }
  const local = relayOnlyLocal();
  return local ? <p style={{ ...styles.errorHint, marginBottom: 12 }}>{local}</p> : null;
}

/** Every relay failing, more than once each: news, with a Try now */
export function RelayDown() {
  const node = useNode();
  const network = useNetwork();
  const now = useNow();
  const relays = network.relays.filter((relay) => relay.state !== 'stopped');
  const elsewhere = relays.length > 0 && relays.every((relay) => relay.closeCode === CLOSE_DID_TAKEN);
  const down = relays.length > 0 && relays.every((relay) => relay.state !== 'open' && relay.failures >= 2);
  if (!down && !elsewhere) return null;
  const retry = nextRetry(network);
  return (
    <div
      role="status"
      style={{
        ...styles.errorBox,
        marginTop: 0,
        marginBottom: 16,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ flex: 1, minWidth: 200 }}>
        <p style={styles.error}>{elsewhere ? 'This app is open in another tab' : "Can't reach the relay"}</p>
        <p style={styles.errorHint}>
          {elsewhere
            ? 'Only one tab or window of an app can sync at a time. Close the other one and this one takes over.'
            : "Your changes are saved on this device and go out to your other devices once it's back."}
          {retry?.retryAt ? ` Trying again in ${duration(retry.retryAt - now)}.` : ' Trying again…'}
        </p>
      </div>
      <button type="button" onClick={() => node.network.reconnect()} style={styles.smallButton}>
        Try now
      </button>
    </div>
  );
}
