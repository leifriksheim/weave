/**
 * @module storage/blob/s3
 * A blob store in any S3-compatible bucket: Cloudflare R2, Backblaze B2,
 * MinIO, Wasabi, AWS itself.
 *
 * Requests are signed with `aws4fetch` rather than the AWS SDK or hand-written
 * SigV4 (see docs/DEPENDENCIES.md): tiny, no dependencies, `fetch` and
 * `crypto.subtle` only, so it runs in browsers, Node and Bun alike.
 */
import { AwsClient } from 'aws4fetch';
import type { BlobStore } from '../blob-store.js';

export interface S3Config {
  /** https://<account>.r2.cloudflarestorage.com, https://s3.us-west-004.backblazeb2.com, … */
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** R2 ignores it but the signature needs one: `auto` */
  readonly region?: string;
  /** A namespace within the bucket */
  readonly prefix?: string;
  /** For tests */
  readonly fetch?: typeof fetch;
}

/** Attempts per request before giving up, on 429 and 5xx */
const ATTEMPTS = 5;

export function createS3BlobStore(config: S3Config): BlobStore {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: config.region ?? 'auto',
  });
  const call = config.fetch ?? fetch;
  const base = `${config.endpoint.replace(/\/+$/, '')}/${config.bucket}`;
  const prefix = config.prefix ? `${config.prefix.replace(/\/+$/, '')}/` : '';
  const objectUrl = (key: string) => `${base}/${(prefix + key).split('/').map(encodeURIComponent).join('/')}`;

  /** Signs and sends, backing off on 429 and 5xx, honouring Retry-After */
  async function send(url: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 1; ; attempt += 1) {
      const signed = await client.sign(url, init);
      const response = await call(signed);
      if (response.status !== 429 && response.status < 500) return response;
      if (attempt >= ATTEMPTS) return response;
      const after = Number(response.headers.get('retry-after'));
      const wait = Number.isFinite(after) && after > 0 ? after * 1000 : Math.min(200 * 2 ** attempt, 5000) * (0.5 + Math.random() / 2);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  const fail = async (what: string, response: Response) => {
    // The body can name the bucket and key, never a credential; the signed URL is not repeated.
    throw new Error(`S3 ${what} failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
  };

  return Object.freeze({
    async get(key: string) {
      const response = await send(objectUrl(key));
      if (response.status === 404) return null;
      if (!response.ok) await fail('get', response);
      return new Uint8Array(await response.arrayBuffer());
    },

    async put(key: string, bytes: Uint8Array) {
      const response = await send(objectUrl(key), { method: 'PUT', body: bytes as BodyInit });
      if (!response.ok) await fail('put', response);
    },

    async delete(key: string) {
      const response = await send(objectUrl(key), { method: 'DELETE' });
      // Already gone is gone.
      if (!response.ok && response.status !== 404) await fail('delete', response);
    },

    async list(within: string) {
      const keys: string[] = [];
      let token: string | null = null;
      do {
        const query = new URLSearchParams({ 'list-type': '2', prefix: prefix + within });
        if (token) query.set('continuation-token', token);
        const response = await send(`${base}?${query}`);
        if (!response.ok) await fail('list', response);
        const xml = await response.text();
        for (const match of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(unescapeXml(match[1]!).slice(prefix.length));
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? (/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1] ?? null) : null;
        if (token) token = unescapeXml(token);
      } while (token);
      return keys;
    },
  });
}

function unescapeXml(text: string): string {
  return text.replace(/&(lt|gt|quot|apos|amp);/g, (_, name: string) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[name]!);
}
