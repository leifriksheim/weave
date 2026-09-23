/**
 * @module passkey-diagnostics
 * Reports what a browser and credential provider actually do with the PRF
 * extension, so a failure can be pinned on a specific link in the chain rather
 * than guessed at.
 */

import { base64UrlEncode, base64UrlDecode } from '../utils/encoding.js';

/** Where a ceremony's PRF request ended up */
export interface CeremonyReport {
  readonly attempted: boolean;
  /** Raw client extension results, with binary values summarized */
  readonly extensionResults: Record<string, unknown> | null;
  /** Bytes of PRF output this ceremony produced, or null for none */
  readonly prfOutputBytes: number | null;
  readonly error?: string;
}

export interface PasskeyDiagnostics {
  readonly webauthnAvailable: boolean;
  readonly platformAuthenticatorAvailable: boolean;
  /** AAGUID of the authenticator that answered, and its name when recognized */
  readonly provider: { readonly aaguid: string | null; readonly name: string | null };
  /** Whether the creation ceremony reported `prf.enabled` */
  readonly prfDeclaredAtCreate: boolean | undefined;
  readonly create: CeremonyReport;
  readonly assert: CeremonyReport;
  /** The only question that matters: did a secret come back? */
  readonly prfWorks: boolean;
  /** A sentence naming the most likely culprit */
  readonly summary: string;
  readonly credentialId: string | null;
}

export interface DiagnosticsOptions {
  readonly rpId?: string;
  readonly rpName?: string;
  /**
   * Test this existing credential instead of creating one. Without it the run
   * creates a throwaway passkey, which will appear in the user's authenticator.
   */
  readonly credentialId?: string;
  readonly userName?: string;
}

const PRF_SALT = new TextEncoder().encode('weave-protocol-key-v1');

/** AAGUIDs of providers common enough to be worth naming. */
const KNOWN_AAGUIDS: Record<string, string> = {
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud Keychain',
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google Password Manager',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  '531126d6-e717-415c-9320-3d9aa6981239': 'Dashlane',
  'fdb141b2-5d84-443e-8a35-4698c205a502': 'KeePassXC',
  '00000000-0000-0000-0000-000000000000': 'Platform authenticator (no AAGUID)',
};

/** Formats the 16 AAGUID bytes that sit at offset 37 of attested credential data. */
function readAaguid(authenticatorData: ArrayBuffer | undefined): string | null {
  if (!authenticatorData || authenticatorData.byteLength < 53) return null;
  const bytes = new Uint8Array(authenticatorData).slice(37, 53);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Replaces binary values with a readable summary so the report can be shown or copied. */
function summarizeExtensions(results: unknown): Record<string, unknown> | null {
  if (!results || typeof results !== 'object') return null;

  const walk = (value: unknown): unknown => {
    if (value instanceof ArrayBuffer) return `<${value.byteLength} bytes>`;
    if (ArrayBuffer.isView(value)) return `<${value.byteLength} bytes>`;
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };

  return walk(results) as Record<string, unknown>;
}

function prfOutputLength(results: unknown): number | null {
  const first = (results as { prf?: { results?: { first?: ArrayBuffer } } })?.prf?.results?.first;
  return first ? first.byteLength : null;
}

/**
 * Runs the PRF ceremonies and reports what came back at each step.
 *
 * Creating a passkey and asserting it are separate conversations with the
 * provider, and PRF can be dropped in either — this shows which.
 *
 * @param options Which credential to test, and how to identify the site
 * @returns A structured report, safe to display or copy into a bug report
 */
export async function inspectPasskeyPrf(options?: DiagnosticsOptions): Promise<PasskeyDiagnostics> {
  const webauthnAvailable = !!globalThis.navigator?.credentials?.create;
  const rpId =
    options?.rpId ?? (typeof globalThis.location !== 'undefined' ? globalThis.location.hostname : 'localhost');

  let platformAuthenticatorAvailable = false;
  try {
    platformAuthenticatorAvailable =
      (await globalThis.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable?.()) ?? false;
  } catch {
    platformAuthenticatorAvailable = false;
  }

  const create: {
    attempted: boolean;
    extensionResults: Record<string, unknown> | null;
    prfOutputBytes: number | null;
    error?: string;
  } = { attempted: false, extensionResults: null, prfOutputBytes: null };

  const assert: {
    attempted: boolean;
    extensionResults: Record<string, unknown> | null;
    prfOutputBytes: number | null;
    error?: string;
  } = { attempted: false, extensionResults: null, prfOutputBytes: null };

  let credentialId = options?.credentialId ?? null;
  let aaguid: string | null = null;
  let prfDeclaredAtCreate: boolean | undefined;

  if (!webauthnAvailable) {
    return Object.freeze({
      webauthnAvailable,
      platformAuthenticatorAvailable,
      provider: { aaguid: null, name: null },
      prfDeclaredAtCreate: undefined,
      create: Object.freeze(create),
      assert: Object.freeze(assert),
      prfWorks: false,
      summary: 'WebAuthn is unavailable in this browser, so passkeys cannot be used at all.',
      credentialId: null,
    });
  }

  // 1. Creation — unless we were pointed at an existing credential.
  if (!credentialId) {
    create.attempted = true;
    try {
      const credential = (await globalThis.navigator.credentials.create({
        publicKey: {
          rp: { id: rpId, name: options?.rpName ?? 'PRF diagnostic' },
          user: {
            id: globalThis.crypto.getRandomValues(new Uint8Array(32)) as BufferSource,
            name: options?.userName ?? 'prf-diagnostic',
            displayName: options?.userName ?? 'PRF diagnostic (safe to delete)',
          },
          challenge: globalThis.crypto.getRandomValues(new Uint8Array(32)),
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 },
          ],
          authenticatorSelection: {
            residentKey: 'required',
            requireResidentKey: true,
            userVerification: 'required',
          },
          extensions: { prf: { eval: { first: PRF_SALT } } } as AuthenticationExtensionsClientInputs,
        },
      })) as PublicKeyCredential;

      const results = credential.getClientExtensionResults();
      create.extensionResults = summarizeExtensions(results);
      create.prfOutputBytes = prfOutputLength(results);
      prfDeclaredAtCreate = (results as { prf?: { enabled?: boolean } }).prf?.enabled;
      credentialId = base64UrlEncode(new Uint8Array(credential.rawId));

      const response = credential.response as AuthenticatorAttestationResponse;
      aaguid = readAaguid(response.getAuthenticatorData?.());
    } catch (error) {
      create.error = error instanceof Error ? `${error.name}: ${error.message}` : 'Creation failed';
    }
  }

  // 2. Assertion — the ceremony that actually has to yield a secret.
  if (credentialId) {
    assert.attempted = true;
    try {
      const credential = (await globalThis.navigator.credentials.get({
        publicKey: {
          challenge: globalThis.crypto.getRandomValues(new Uint8Array(32)),
          rpId,
          userVerification: 'required',
          allowCredentials: [{ type: 'public-key', id: base64UrlDecode(credentialId) as BufferSource }],
          extensions: { prf: { eval: { first: PRF_SALT } } } as AuthenticationExtensionsClientInputs,
        },
      })) as PublicKeyCredential;

      const results = credential.getClientExtensionResults();
      assert.extensionResults = summarizeExtensions(results);
      assert.prfOutputBytes = prfOutputLength(results);
    } catch (error) {
      assert.error = error instanceof Error ? `${error.name}: ${error.message}` : 'Assertion failed';
    }
  }

  const prfWorks = (assert.prfOutputBytes ?? 0) > 0 || (create.prfOutputBytes ?? 0) > 0;
  const providerName = aaguid ? (KNOWN_AAGUIDS[aaguid] ?? null) : null;

  return Object.freeze({
    webauthnAvailable,
    platformAuthenticatorAvailable,
    provider: Object.freeze({ aaguid, name: providerName }),
    prfDeclaredAtCreate,
    create: Object.freeze(create),
    assert: Object.freeze(assert),
    prfWorks,
    summary: describe({ prfWorks, prfDeclaredAtCreate, create, assert, providerName }),
    credentialId,
  });
}

/** Turns the raw findings into one sentence naming the likely culprit. */
function describe(facts: {
  prfWorks: boolean;
  prfDeclaredAtCreate: boolean | undefined;
  create: { error?: string; extensionResults: Record<string, unknown> | null };
  assert: { attempted: boolean; error?: string; extensionResults: Record<string, unknown> | null };
  providerName: string | null;
}): string {
  const who = facts.providerName ? `${facts.providerName} ` : 'This provider ';

  if (facts.create.error) return `The passkey could not be created: ${facts.create.error}`;
  if (facts.prfWorks) return `${who}supports PRF — identity derivation will work with this passkey.`;
  if (facts.assert.error) return `The assertion failed before PRF could be evaluated: ${facts.assert.error}`;

  const sawPrfKey =
    facts.create.extensionResults !== null && 'prf' in facts.create.extensionResults;

  if (!sawPrfKey) {
    return `${who}returned no \`prf\` entry at all, which usually means the extension was dropped before reaching the authenticator — the provider handling the ceremony does not implement PRF.`;
  }
  if (facts.prfDeclaredAtCreate === false) {
    return `${who}explicitly reported PRF as unavailable for this credential (\`prf.enabled: false\`).`;
  }
  return `${who}acknowledged the PRF extension but evaluated no secret, so the credential has no hmac-secret to derive from.`;
}
