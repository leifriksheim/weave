/**
 * @module negentropy
 * Range-based set reconciliation: two peers find out which items each lacks
 * by comparing fingerprints of ranges, never by listing everything.
 *
 * This is Negentropy protocol version 1 as Nostr uses it (NIP-77), ported
 * from Doug Hoyte's reference implementation (MIT). Only the wire format is
 * shared; the storage around it is ours.
 *
 * Both sides sort their items by (timestamp, id). The initiator sends
 * fingerprints of a few ranges covering everything. For each range the other
 * side agrees with, nothing more is said. For a range it doesn't, it splits
 * the range into sixteen and answers with their fingerprints, or with the ids
 * themselves once a range is small. A few rounds narrow every difference down
 * to the ids, and the initiator ends up knowing both what it has that the
 * other lacks and what the other has that it lacks.
 *
 * A fingerprint is the sum of the ids in a range, as 256-bit numbers, hashed
 * with the count. A sum can be taken apart and put together again, which is
 * what lets a store keep one per collection and add or subtract as versions
 * come and go.
 *
 * The timestamp only orders items. It never decides which items are compared:
 * a writer who lies about the time makes its own items slower to find, nothing
 * else.
 */
import { sha256 } from '../utils/hash.js';

export const NEGENTROPY_VERSION = 0x61;
export const ID_SIZE = 32;
export const FINGERPRINT_SIZE = 16;
/** Ranges smaller than two buckets' worth go as their ids */
const BUCKETS = 16;
/** A timestamp past every real one: the end of the last range */
const INFINITY = Number.MAX_SAFE_INTEGER;

const enum Mode {
  Skip = 0,
  Fingerprint = 1,
  IdList = 2,
}

/** One thing in a set: when (for ordering only) and its 32-byte id */
export interface Item {
  readonly timestamp: number;
  readonly id: Uint8Array;
}

interface Bound {
  readonly timestamp: number;
  /** A prefix of an id, just long enough to fall between two neighbours */
  readonly id: Uint8Array;
}

// ─── Bytes ─────────────────────────────────────────────────────────

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

export function compareItems(a: Bound, b: Bound): number {
  return a.timestamp === b.timestamp ? compareBytes(a.id, b.id) : a.timestamp < b.timestamp ? -1 : 1;
}

/** Negentropy's varint: seven bits a byte, most significant first. Arithmetic, so it holds past 32 bits. */
function encodeVarInt(n: number): number[] {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('varint out of range');
  const out = [n % 128];
  n = Math.floor(n / 128);
  while (n > 0) {
    out.push((n % 128) | 128);
    n = Math.floor(n / 128);
  }
  return out.reverse();
}

class Writer {
  private bytes: number[] = [];
  get length() {
    return this.bytes.length;
  }
  push(...values: ReadonlyArray<number | ArrayLike<number>>): void {
    for (const value of values) {
      if (typeof value === 'number') this.bytes.push(value);
      else for (let i = 0; i < value.length; i++) this.bytes.push(value[i]!);
    }
  }
  append(other: Writer): void {
    this.push(other.bytes);
  }
  done(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

class Reader {
  private at = 0;
  constructor(private readonly bytes: Uint8Array) {}
  get remaining() {
    return this.bytes.length - this.at;
  }
  byte(): number {
    if (this.at >= this.bytes.length) throw new Error('Negentropy message ends too soon');
    return this.bytes[this.at++]!;
  }
  take(n: number): Uint8Array {
    if (this.remaining < n) throw new Error('Negentropy message ends too soon');
    const out = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
  varint(): number {
    let n = 0;
    for (;;) {
      const byte = this.byte();
      n = n * 128 + (byte & 127);
      if (!Number.isSafeInteger(n)) throw new Error('Negentropy varint too large');
      if ((byte & 128) === 0) return n;
    }
  }
}

// ─── Fingerprints ──────────────────────────────────────────────────

const MOD = 1n << 256n;

/** An id as the little-endian 256-bit number the sum is taken over */
export function idToNumber(id: Uint8Array): bigint {
  const view = new DataView(id.buffer, id.byteOffset, ID_SIZE);
  return (
    view.getBigUint64(0, true) |
    (view.getBigUint64(8, true) << 64n) |
    (view.getBigUint64(16, true) << 128n) |
    (view.getBigUint64(24, true) << 192n)
  );
}

/** The sum of some ids, and how many — a range's fingerprint before hashing */
export interface Sum {
  readonly sum: bigint;
  readonly count: number;
}

export const EMPTY_SUM: Sum = { sum: 0n, count: 0 };

export const addToSum = (s: Sum, id: Uint8Array): Sum => ({ sum: (s.sum + idToNumber(id)) % MOD, count: s.count + 1 });
export const removeFromSum = (s: Sum, id: Uint8Array): Sum => ({ sum: (s.sum - idToNumber(id) + MOD) % MOD, count: s.count - 1 });
export const combineSums = (a: Sum, b: Sum): Sum => ({ sum: (a.sum + b.sum) % MOD, count: a.count + b.count });

/** Hashes a sum the one way both sides do: 32 little-endian bytes, then the count as a varint */
export async function fingerprintOf(s: Sum): Promise<Uint8Array> {
  const input = new Uint8Array(ID_SIZE + 10);
  let n = s.sum;
  for (let i = 0; i < ID_SIZE; i++) {
    input[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  const count = encodeVarInt(s.count);
  input.set(count, ID_SIZE);
  return (await sha256(input.subarray(0, ID_SIZE + count.length))).subarray(0, FINGERPRINT_SIZE);
}

// ─── A sorted set ──────────────────────────────────────────────────

/**
 * Items sorted by (timestamp, id), with running sums so any range's
 * fingerprint costs two lookups rather than a pass over it.
 */
export class ItemSet {
  readonly items: ReadonlyArray<Item>;
  /** prefix[i] is the sum of the first i ids */
  private readonly prefix: bigint[];

  constructor(items: Iterable<Item>) {
    const sorted = [...items].sort(compareItems);
    const unique: Item[] = [];
    for (const item of sorted) {
      if (item.id.length !== ID_SIZE) throw new Error('Negentropy ids are 32 bytes');
      const last = unique[unique.length - 1];
      if (!last || compareItems(last, item) !== 0) unique.push(item);
    }
    this.items = unique;
    this.prefix = [0n];
    for (const item of unique) this.prefix.push((this.prefix[this.prefix.length - 1]! + idToNumber(item.id)) % MOD);
  }

  get size() {
    return this.items.length;
  }

  sum(begin: number, end: number): Sum {
    return { sum: (this.prefix[end]! - this.prefix[begin]! + MOD) % MOD, count: end - begin };
  }

  fingerprint(begin: number, end: number): Promise<Uint8Array> {
    return fingerprintOf(this.sum(begin, end));
  }

  /** The first index in [begin, end) whose item is not below `bound` */
  lowerBound(begin: number, end: number, bound: Bound): number {
    let lo = begin;
    let hi = end;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareItems(this.items[mid]!, bound) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

// ─── The protocol ──────────────────────────────────────────────────

export interface Round {
  /** What to send next; null when the initiator is done */
  readonly message: Uint8Array | null;
  /** Ids this side holds and the other lacks (initiator only) */
  readonly have: ReadonlyArray<Uint8Array>;
  /** Ids the other side holds and this one lacks (initiator only) */
  readonly need: ReadonlyArray<Uint8Array>;
}

/**
 * One side of one reconciliation.
 *
 * @param set This side's items
 * @param frameSizeLimit Largest message to produce, in bytes; 0 for no limit.
 *   What doesn't fit is left for the next round.
 */
export function createReconciler(set: ItemSet, options: { readonly initiator: boolean; readonly frameSizeLimit?: number }) {
  const { initiator } = options;
  const frameSizeLimit = options.frameSizeLimit ?? 0;
  if (frameSizeLimit !== 0 && frameSizeLimit < 4096) throw new Error('frameSizeLimit too small');
  const exceeded = (n: number) => frameSizeLimit !== 0 && n > frameSizeLimit - 200;

  let lastIn = 0;
  let lastOut = 0;

  const encodeTimestamp = (timestamp: number): number[] => {
    if (timestamp === INFINITY) {
      lastOut = INFINITY;
      return encodeVarInt(0);
    }
    const delta = timestamp - lastOut;
    lastOut = timestamp;
    return encodeVarInt(delta + 1);
  };

  const decodeTimestamp = (reader: Reader): number => {
    const raw = reader.varint();
    if (raw === 0 || lastIn === INFINITY) {
      lastIn = INFINITY;
      return INFINITY;
    }
    const timestamp = lastIn + raw - 1;
    if (!Number.isSafeInteger(timestamp)) throw new Error('Negentropy timestamp too large');
    lastIn = timestamp;
    return timestamp;
  };

  const writeBound = (out: Writer, bound: Bound) => out.push(encodeTimestamp(bound.timestamp), encodeVarInt(bound.id.length), bound.id);

  const readBound = (reader: Reader): Bound => {
    const timestamp = decodeTimestamp(reader);
    const length = reader.varint();
    if (length > ID_SIZE) throw new Error('Negentropy bound too long');
    return { timestamp, id: reader.take(length) };
  };

  /** The shortest bound that falls after `prev` and not after `curr` */
  const minimalBound = (prev: Item, curr: Item): Bound => {
    if (curr.timestamp !== prev.timestamp) return { timestamp: curr.timestamp, id: new Uint8Array(0) };
    let shared = 0;
    while (shared < ID_SIZE && curr.id[shared] === prev.id[shared]) shared++;
    return { timestamp: curr.timestamp, id: curr.id.subarray(0, shared + 1) };
  };

  const splitRange = async (lower: number, upper: number, upperBound: Bound, out: Writer) => {
    const count = upper - lower;
    if (count < BUCKETS * 2) {
      writeBound(out, upperBound);
      out.push(encodeVarInt(Mode.IdList), encodeVarInt(count));
      for (let i = lower; i < upper; i++) out.push(set.items[i]!.id);
      return;
    }
    const per = Math.floor(count / BUCKETS);
    const extra = count % BUCKETS;
    let at = lower;
    for (let i = 0; i < BUCKETS; i++) {
      const size = per + (i < extra ? 1 : 0);
      const fingerprint = await set.fingerprint(at, at + size);
      at += size;
      writeBound(out, at === upper ? upperBound : minimalBound(set.items[at - 1]!, set.items[at]!));
      out.push(encodeVarInt(Mode.Fingerprint), fingerprint);
    }
  };

  return {
    /** The first message: the whole set, split into ranges. Initiator only. */
    async initiate(): Promise<Uint8Array> {
      if (!initiator) throw new Error('Only the initiator starts');
      lastOut = 0;
      const out = new Writer();
      out.push(NEGENTROPY_VERSION);
      await splitRange(0, set.size, { timestamp: INFINITY, id: new Uint8Array(0) }, out);
      return out.done();
    },

    /** Takes the other side's message and works out the answer. */
    async reconcile(message: Uint8Array): Promise<Round> {
      const have: Uint8Array[] = [];
      const need: Uint8Array[] = [];
      const reader = new Reader(message);
      lastIn = 0;
      lastOut = 0;

      const full = new Writer();
      full.push(NEGENTROPY_VERSION);

      const version = reader.byte();
      if (version < 0x60 || version > 0x6f) throw new Error('Not a Negentropy message');
      if (version !== NEGENTROPY_VERSION) {
        // A responder answers with its own version, and a newer initiator falls back to it.
        if (initiator) throw new Error(`Unsupported Negentropy version ${version - 0x60}`);
        return { message: full.done(), have, need };
      }

      let prevBound: Bound = { timestamp: 0, id: new Uint8Array(0) };
      let prevIndex = 0;
      let skip = false;

      while (reader.remaining > 0) {
        let out = new Writer();
        const flushSkip = () => {
          if (!skip) return;
          skip = false;
          writeBound(out, prevBound);
          out.push(encodeVarInt(Mode.Skip));
        };

        const currBound = readBound(reader);
        const mode = reader.varint();
        const lower = prevIndex;
        let upper = set.lowerBound(prevIndex, set.size, currBound);

        if (mode === Mode.Skip) {
          skip = true;
        } else if (mode === Mode.Fingerprint) {
          const theirs = reader.take(FINGERPRINT_SIZE);
          const ours = await set.fingerprint(lower, upper);
          if (compareBytes(theirs, ours) !== 0) {
            flushSkip();
            await splitRange(lower, upper, currBound, out);
          } else {
            skip = true;
          }
        } else if (mode === Mode.IdList) {
          const n = reader.varint();
          const theirs = new Map<string, Uint8Array>();
          for (let i = 0; i < n; i++) {
            const id = reader.take(ID_SIZE);
            if (initiator) theirs.set(key(id), id);
          }
          if (initiator) {
            skip = true;
            for (let i = lower; i < upper; i++) {
              const id = set.items[i]!.id;
              if (!theirs.delete(key(id))) have.push(id);
            }
            need.push(...theirs.values());
          } else {
            flushSkip();
            const ids = new Writer();
            let count = 0;
            let endBound: Bound = currBound;
            for (let i = lower; i < upper; i++) {
              if (exceeded(full.length + ids.length)) {
                endBound = set.items[i]!;
                upper = i; // the rest of the range gets a fingerprint below
                break;
              }
              ids.push(set.items[i]!.id);
              count++;
            }
            writeBound(out, endBound);
            out.push(encodeVarInt(Mode.IdList), encodeVarInt(count));
            out.append(ids);
            full.append(out);
            out = new Writer();
          }
        } else {
          throw new Error('Unknown Negentropy mode');
        }

        if (exceeded(full.length + out.length)) {
          // Out of room: one fingerprint for everything not covered yet, answered next round.
          writeBound(full, { timestamp: INFINITY, id: new Uint8Array(0) });
          full.push(encodeVarInt(Mode.Fingerprint), await set.fingerprint(upper, set.size));
          break;
        }
        full.append(out);
        prevIndex = upper;
        prevBound = currBound;
      }

      return { message: initiator && full.length === 1 ? null : full.done(), have, need };
    },
  };
}

const key = (id: Uint8Array) => String.fromCharCode(...id);
