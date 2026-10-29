import { argon2id } from 'hash-wasm';

// Envelope used for both the local IndexedDB vault and .budget backups (Decisions 4, 6, 11).
// Header fields are bound as AES-GCM additional data, so tampering with them fails decryption.

export const ENVELOPE_FORMAT = 'moonli-budget';
export const ENVELOPE_VERSION = 1;

export const KDF_DEFAULTS = { name: 'argon2id', t: 2, m: 19456, p: 1, hashLength: 32 } as const;

export interface Envelope {
  format: typeof ENVELOPE_FORMAT;
  version: typeof ENVELOPE_VERSION;
  createdAt: string;
  kdf: { name: 'argon2id'; t: number; m: number; p: number; hashLength: number };
  salt: string;
  nonce: string;
  ciphertext: string;
}

export type CryptoErrorCode = 'wrong-password' | 'corrupt' | 'unsupported';

export class CryptoError extends Error {
  constructor(public readonly code: CryptoErrorCode, message: string) {
    super(message);
  }
}

export type RandomSource = (n: number) => Uint8Array<ArrayBuffer>;

const defaultRandom: RandomSource = (n) => crypto.getRandomValues(new Uint8Array(new ArrayBuffer(n)));

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(text: string): Uint8Array<ArrayBuffer> {
  if (typeof text !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw new CryptoError('corrupt', 'Invalid encoding');
  let bin: string;
  try { bin = atob(text); } catch { throw new CryptoError('corrupt', 'Invalid encoding'); }
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function aad(env: Omit<Envelope, 'salt' | 'nonce' | 'ciphertext'>): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(env));
}

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>, kdf: Envelope['kdf']): Promise<CryptoKey> {
  const raw = await argon2id({
    password,
    salt,
    iterations: kdf.t,
    memorySize: kdf.m,
    parallelism: kdf.p,
    hashLength: kdf.hashLength,
    outputType: 'binary',
  });
  return crypto.subtle.importKey('raw', new Uint8Array(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Encrypts plaintext with a fresh random salt and nonce (Decision 4). Returns the envelope JSON. */
export async function sealEnvelope(plaintext: string, password: string, createdAt: string, random: RandomSource = defaultRandom): Promise<string> {
  const header = {
    format: ENVELOPE_FORMAT,
    version: ENVELOPE_VERSION,
    createdAt,
    kdf: { ...KDF_DEFAULTS },
  } as const;
  const salt = random(16);
  const nonce = random(12);
  const key = await deriveKey(password, salt, header.kdf);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(header) }, key, new TextEncoder().encode(plaintext)),
  );
  const env: Envelope = { ...header, salt: toB64(salt), nonce: toB64(nonce), ciphertext: toB64(ct) };
  return JSON.stringify(env);
}

/** Verifies the envelope structure and decrypts it. Nothing is returned on any failure. */
export async function openEnvelope(text: string, password: string): Promise<string> {
  let env: Envelope;
  try {
    env = JSON.parse(text) as Envelope;
  } catch {
    throw new CryptoError('corrupt', 'The file is not a valid budget file');
  }
  if (!env || env.format !== ENVELOPE_FORMAT) throw new CryptoError('corrupt', 'The file is not a budget file');
  if (env.version !== ENVELOPE_VERSION) throw new CryptoError('unsupported', `Unsupported file version ${String(env.version)}`);
  const kdf = env.kdf;
  if (
    !kdf || kdf.name !== 'argon2id' || !Number.isInteger(kdf.t) || kdf.t < 1 || kdf.t > 10 ||
    !Number.isInteger(kdf.m) || kdf.m < 8192 || kdf.m > 262144 || !Number.isInteger(kdf.p) || kdf.p < 1 || kdf.p > 4 ||
    kdf.hashLength !== 32
  ) {
    throw new CryptoError('corrupt', 'Unsupported key derivation parameters');
  }
  if (typeof env.createdAt !== 'string' || !Number.isFinite(Date.parse(env.createdAt))) throw new CryptoError('corrupt', 'Invalid creation time');
  const salt = fromB64(env.salt);
  const nonce = fromB64(env.nonce);
  const ct = fromB64(env.ciphertext);
  if (salt.length !== 16 || nonce.length !== 12 || ct.length < 16) throw new CryptoError('corrupt', 'The file is truncated or damaged');

  const key = await deriveKey(password, salt, kdf);
  const header = { format: env.format, version: env.version, createdAt: env.createdAt, kdf: env.kdf };
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(header) }, key, ct);
    return new TextDecoder().decode(pt);
  } catch {
    throw new CryptoError('wrong-password', 'Wrong password, or the file has been altered');
  }
}

/** Reads the unencrypted header (creation time) without decrypting. */
export function envelopeCreatedAt(text: string): string | null {
  try {
    const env = JSON.parse(text) as Partial<Envelope>;
    return typeof env.createdAt === 'string' ? env.createdAt : null;
  } catch {
    return null;
  }
}
