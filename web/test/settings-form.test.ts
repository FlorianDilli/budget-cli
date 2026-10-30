// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../src/state/session', () => ({ useSession: () => session.value }));
import { Settings } from '../src/ui/Settings';
import { parseSettings } from '../src/domain/config';
import { SAMPLE_SETTINGS } from '../src/domain/sample';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;
let saveSettings: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  saveSettings = vi.fn(async () => ({ ok: true }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render() {
  function Harness() {
    const [drafts, setDrafts] = useState<{ settings: string | null; financials: string | null }>({ settings: null, financials: null });
    session.value = {
      snapshot: { settingsToml: SAMPLE_SETTINGS, financialsToml: '' },
      isSample: false,
      drafts,
      setDraft: (kind: 'settings' | 'financials', text: string) => setDrafts((old) => ({ ...old, [kind]: text })),
      saveSettings,
    };
    return createElement(MemoryRouter, null, createElement(Settings));
  }
  await act(async () => root.render(createElement(Harness)));
}

const button = (label: string) => Array.from(container.querySelectorAll('button')).find((el) => el.textContent === label) as HTMLButtonElement;
const field = (label: string) => {
  const wrapper = Array.from(container.querySelectorAll('label')).find((el) => el.querySelector('.setting-label')?.firstChild?.textContent === label);
  if (!wrapper) throw new Error(`No field "${label}"`);
  return wrapper.querySelector('input, select') as HTMLInputElement;
};

async function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('edits settings through the form and saves valid generated TOML', async () => {
  await render();
  expect(container.querySelector('textarea')).toBeNull();
  expect(button('Save').disabled).toBe(true);

  await typeInto(field('Currency symbol'), 'USD');
  expect(button('Save').disabled).toBe(false);
  await act(async () => button('Save').click());

  const text = saveSettings.mock.calls[0][0] as string;
  const parsed = parseSettings(text);
  expect(parsed.ok).toBe(true);
  if (parsed.ok) {
    expect(parsed.value.currencySymbol).toBe('USD');
    expect(parsed.value.formats[0].name).toBe('Demo Bank');
    expect(parsed.value.formats[0].balanceSnapshot).toBe(100000);
  }
});

it('blocks saving while a required import column is empty', async () => {
  await render();
  await typeInto(field('Date column'), '');
  expect(button('Save').disabled).toBe(true);
  expect(container.querySelector('[role=alert]')?.textContent).toContain('date_column is required');
  await typeInto(field('Date column'), 'Booking Date');
  expect(container.querySelector('[role=alert]')).toBeNull();
  expect(button('Save').disabled).toBe(true);
});

it('adds an import format and reports the missing columns until it is complete', async () => {
  await render();
  expect(container.querySelectorAll('.format-card')).toHaveLength(1);
  await act(async () => button('Add format').click());
  expect(container.querySelectorAll('.format-card')).toHaveLength(2);
  expect(button('Save').disabled).toBe(true);
  expect(container.querySelector('[role=alert]')?.textContent).toContain('date_column is required');
});
