/** Small pieces for tests that run a real server on a free port. */
import type { AddressInfo } from 'node:net';
import type { RawData } from 'ws';

/** The port a listening server was given */
export function portOf(server: { address(): string | AddressInfo | null }): number {
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('The server is not listening on a port');
  return address.port;
}

/** A frame from `ws` as text, however it arrived */
export function textOf(data: RawData): string {
  return (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(new Uint8Array(data))).toString();
}
