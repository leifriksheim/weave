import { styles } from '../styles';

/** A few lines on what is going on underneath, folded away */
export function HowItWorks() {
  return (
    <details style={styles.panel}>
      <summary data-variant="ghost" style={styles.panelSummary}>How it works</summary>
      <ul style={styles.infoList}>
        <li>Each <strong>space</strong> has its own store, its own sync, its own gossip room</li>
        <li>Private spaces encrypt every body with an AES key <em>before</em> signing, so peers relay what they cannot read</li>
        <li>Every space is the same kind: it is yours alone until you invite someone, and each invite link gives a role that decides what they may change</li>
        <li>Invites carry the space — and its key — in the URL fragment, which never reaches a server</li>
        <li>Peers meet through a relay only for the <em>first</em> connection; after that they introduce each other</li>
        <li>A phone cannot open a folder, so it takes its own copy — the QR hands over the identity, and the spaces follow over the peer connection</li>
        <li>A <strong>data folder</strong> is the only store that is not scoped to this origin — point a second app at it and you get the same account and the same spaces</li>
        <li>Screens are worked out from what a space says about itself — its collections, their fields and how records point at each other — so this app shows data it has never seen before</li>
        <li>“verified” on a record means its signature and delegation chain both check out here</li>
      </ul>
    </details>
  );
}
