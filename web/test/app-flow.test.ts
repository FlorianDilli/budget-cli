// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import 'fake-indexeddb/auto';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { deleteVault, readVault } from '../src/storage/vault';
import { sealEnvelope, openEnvelope } from '../src/crypto/envelope';
import { emptySnapshot } from '../src/domain/snapshot';
import { SAMPLE_FINANCIALS, SAMPLE_SETTINGS } from '../src/domain/sample';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

async function renderApp() {
  root = createRoot(container);
  await act(async () => root.render(createElement(MemoryRouter, null, createElement(App))));
}

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for UI: ${container.textContent}`);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  }
}

function button(text: string): HTMLButtonElement {
  const result = Array.from(container.querySelectorAll('button')).find((el) => el.textContent?.trim() === text);
  if (!result) throw new Error(`Button not found: ${text}`);
  return result;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

async function fill(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(async () => {
  await deleteVault();
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container.remove();
  await deleteVault();
});

describe('app security and navigation flow', () => {
  it('imports an encrypted .budget file during first-time setup', async () => {
    const backupPassword = 'backup password';
    const backupSnapshot = {
      ...emptySnapshot('2026-10-30T12:00:00.000Z'),
      settingsToml: SAMPLE_SETTINGS,
      financialsToml: SAMPLE_FINANCIALS,
    };
    const backupText = await sealEnvelope(JSON.stringify(backupSnapshot), backupPassword, backupSnapshot.savedAt);

    await renderApp();
    await waitFor(() => container.querySelector('input[type=file]') !== null);
    expect(container.textContent).toContain('Import a .budget file');
    const fileInput = container.querySelector<HTMLInputElement>('input[type=file]')!;
    const backupFile = new File([backupText], 'backup.budget', { type: 'application/json' });
    Object.defineProperty(backupFile, 'text', { value: async () => backupText });
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [backupFile] });
    await act(async () => fileInput.dispatchEvent(new Event('input', { bubbles: true })));
    await act(async () => fileInput.dispatchEvent(new Event('change', { bubbles: true })));
    expect(container.querySelector('.file-picker-name')?.textContent).toBe('backup.budget');
    expect(button('Import budget').disabled).toBe(false);
    await fill(container.querySelector<HTMLInputElement>('input[autocomplete=current-password]')!, backupPassword);
    await click(button('Import budget'));

    await waitFor(() => container.querySelector('nav[aria-label=Main]') !== null);
    const stored = await readVault();
    expect(stored).toBeTruthy();
    expect(JSON.parse(await openEnvelope(stored!, backupPassword))).toMatchObject({
      settingsToml: SAMPLE_SETTINGS,
      financialsToml: SAMPLE_FINANCIALS,
    });
  }, 20000);

  it('validates setup, persists an encrypted vault, and requires the correct password after locking and reload', async () => {
    await renderApp();
    await waitFor(() => container.textContent?.includes('Set up a new budget') === true);
    const inputs = container.querySelectorAll<HTMLInputElement>('input[type=password]');
    await fill(inputs[0], 'correct password');
    await fill(inputs[1], 'different password');
    await click(button('Create encrypted store'));
    expect(container.querySelector('[role=alert]')?.textContent).toContain('passwords do not match');
    expect(await readVault()).toBeNull();

    await fill(inputs[0], 'short');
    await fill(inputs[1], 'short');
    await click(button('Create encrypted store'));
    await waitFor(() => container.querySelector('nav[aria-label=Main]') !== null);
    const encrypted = await readVault();
    expect(encrypted).toBeTruthy();
    expect(encrypted).not.toContain('short');
    expect(encrypted).not.toContain('settingsToml');

    const transactions = Array.from(container.querySelectorAll('nav[aria-label=Main] a')).find((a) => a.textContent?.includes('Transactions'));
    expect(transactions).toBeDefined();
    await click(transactions!);
    expect(container.querySelector('h1')?.textContent).toBe('Transactions');
    expect(container.textContent).toContain('No transactions this month');

    await click(button('Lock'));
    expect(container.querySelector('nav[aria-label=Main]')).toBeNull();
    await fill(container.querySelector<HTMLInputElement>('input[type=password]')!, 'wrong password');
    await click(button('Unlock'));
    await waitFor(() => container.querySelector('[role=alert]') !== null);
    expect(container.querySelector('[role=alert]')?.textContent).toContain('Wrong password');
    expect(container.querySelector<HTMLInputElement>('input[type=password]')?.value).toBe('');
    expect(await readVault()).toBe(encrypted);

    await act(async () => root.unmount());
    await renderApp();
    await waitFor(() => container.querySelector('input[autocomplete=current-password]') !== null);
    await fill(container.querySelector<HTMLInputElement>('input[type=password]')!, 'short');
    await click(button('Unlock'));
    await waitFor(() => container.querySelector('nav[aria-label=Main]') !== null);
    expect(container.textContent).toContain('Preview data is being shown');
    expect(container.querySelectorAll('.nav-icon')).toHaveLength(5);
    const settingsLink = Array.from(container.querySelectorAll('nav[aria-label=Main] a')).find((a) => a.textContent?.includes('Settings'))!;
    await click(settingsLink);
    expect(container.querySelectorAll('.sample-notice')).toHaveLength(1);
    expect(container.querySelector('.sample-notice')?.textContent).toContain('Preview data is being shown');
    expect(container.querySelector('h1')?.compareDocumentPosition(container.querySelector('.sample-notice')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await click(button('Data'));
    expect(container.textContent).not.toContain('Currency: EUR');
    expect(container.querySelector('.sample-notice')?.textContent).toContain('Preview data is being shown');
    expect(container.querySelector('h1')?.compareDocumentPosition(container.querySelector('.sample-notice')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }, 15000);
});
