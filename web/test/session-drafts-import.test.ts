// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import 'fake-indexeddb/auto';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { SessionProvider, useSession } from '../src/state/session';
import { deleteVault } from '../src/storage/vault';
import type { ImportFormat } from '../src/domain/config';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let session: ReturnType<typeof useSession>;
function Probe() { session = useSession(); return null; }

afterEach(async () => { await deleteVault(); });

it('keeps drafts in memory across consumers, clears them on lock, and validates temporary mappings', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(SessionProvider, null, createElement(Probe))));
  await act(async () => { await session.setup('correct password'); });
  await act(async () => { session.setDraft('settings', 'unsaved settings'); session.setDraft('financials', 'unsaved financials'); });
  expect(session.drafts.settings).toBe('unsaved settings');
  expect(session.drafts.financials).toBe('unsaved financials');

  const format: ImportFormat = { name: 'Bank', dateColumn: 'Date', amountColumn: 'Amount', descriptionColumn: 'Description', delimiter: ',', decimalSeparator: '.', thousandsSeparator: '' };
  const csv = 'When,Value,Payee\n2026-01-01,-12.50,Shop';
  const bad = await session.previewImport(csv, 'statement.csv', format);
  expect(bad.ok).toBe(false);
  const good = await session.previewImport(csv, 'statement.csv', { ...format, dateColumn: 'When', amountColumn: 'Value', descriptionColumn: 'Payee' });
  expect(good.ok).toBe(true);
  if (good.ok) expect(good.preview.rows[0]).toMatchObject({ date: '2026-01-01', cents: -1250, description: 'Shop' });
  expect(session.snapshot?.transactions).toHaveLength(0);

  await act(async () => session.lock());
  expect(session.drafts).toEqual({ settings: null, financials: null });
  await act(async () => { await session.unlock('correct password'); });
  expect(session.drafts.settings).not.toBe('unsaved settings');
  await act(async () => root.unmount());
  container.remove();
}, 15000);
