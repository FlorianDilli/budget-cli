import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { CryptoError, openEnvelope, sealEnvelope } from '../src/crypto/envelope';
import { deleteVault, readVault, writeVault } from '../src/storage/vault';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

describe('encrypted envelope', () => {
  it('round trips and uses fresh randomness', async () => {
    const first = await sealEnvelope('private data', 'password', '2026-01-01T00:00:00.000Z');
    const second = await sealEnvelope('private data', 'password', '2026-01-01T00:00:00.000Z');
    expect(JSON.parse(first).salt).not.toBe(JSON.parse(second).salt);
    expect(JSON.parse(first).nonce).not.toBe(JSON.parse(second).nonce);
    expect(await openEnvelope(first, 'password')).toBe('private data');
  });

  it('rejects wrong passwords, tampering, truncation and unknown versions', async () => {
    const text = await sealEnvelope('private data', 'password', '2026-01-01T00:00:00.000Z');
    await expect(openEnvelope(text, 'wrong')).rejects.toMatchObject({ code: 'wrong-password' });
    const env = JSON.parse(text);
    const bytes = Uint8Array.from(atob(env.ciphertext), (c) => c.charCodeAt(0));
    bytes[0] ^= 1;
    env.ciphertext = btoa(String.fromCharCode(...bytes));
    await expect(openEnvelope(JSON.stringify(env), 'password')).rejects.toBeInstanceOf(CryptoError);
    await expect(openEnvelope(text.slice(0, -1), 'password')).rejects.toMatchObject({ code: 'corrupt' });
    await expect(openEnvelope(JSON.stringify({ ...env, version: 999 }), 'password')).rejects.toMatchObject({ code: 'unsupported' });
    await expect(openEnvelope(JSON.stringify({ ...env, salt: 'a' }), 'password')).rejects.toMatchObject({ code: 'corrupt' });
  });
});

describe('vault', () => {
  beforeEach(async () => deleteVault());
  it('stores, replaces and deletes one encrypted snapshot', async () => {
    expect(await readVault()).toBeNull();
    await writeVault('first');
    expect(await readVault()).toBe('first');
    await writeVault('second');
    expect(await readVault()).toBe('second');
    await deleteVault();
    expect(await readVault()).toBeNull();
  });
});
