// @vitest-environment jsdom
import { act, createElement, forwardRef, useImperativeHandle } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { parseFinancials, DEFAULT_SETTINGS } from '../src/domain/config';
import { SAMPLE_FINANCIALS } from '../src/domain/sample';

const jumpToLine = vi.fn();
const session = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../src/state/session', () => ({ useSession: () => session.value, MIN_PASSWORD_LENGTH: 8 }));
vi.mock('../src/ui/TomlEditor', () => ({
  TomlEditor: forwardRef(function MockEditor(_props, ref) {
    useImperativeHandle(ref, () => ({ jumpToLine, insert: vi.fn(), undo: vi.fn(), redo: vi.fn(), search: vi.fn() }));
    return null;
  }),
}));
import { Settings } from '../src/ui/Settings';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it('shows the saved plan, changes months and sort, and jumps to the saved source', async () => {
  const parsed = parseFinancials(SAMPLE_FINANCIALS);
  if (!parsed.ok) throw new Error('Invalid sample');
  session.value = { snapshot: { financialsToml: SAMPLE_FINANCIALS, settingsToml: '' }, settings: DEFAULT_SETTINGS, financials: parsed.value, drafts: { settings: null, financials: null }, isSample: false };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(MemoryRouter, { initialEntries: ['/settings?tab=budget'] }, createElement(Settings))));
    expect(container.textContent).toContain('Savings rate');
    expect(container.textContent).toContain('Due:');
    const months = container.querySelectorAll<HTMLButtonElement>('.month-strip button');
    await act(async () => months[0].click());
    expect(months[0].getAttribute('aria-pressed')).toBe('true');
    const sort = Array.from(container.querySelectorAll('select')).find((el) => el.value === 'amount')!;
    await act(async () => { sort.value = 'category'; sort.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(container.querySelector('.category-heading')).not.toBeNull();
    const source = container.querySelector<HTMLButtonElement>('.plan-item-right button')!;
    const line = Number(source.textContent!.slice(1));
    await act(async () => source.click());
    expect(jumpToLine).toHaveBeenCalledWith(line);
    expect(container.textContent).toContain('financials.toml');
    session.value.drafts = { settings: null, financials: 'invalid unsaved draft' };
    const budgetTab = Array.from(container.querySelectorAll('button')).find((el) => el.textContent === 'Visual Budget')!;
    await act(async () => budgetTab.click());
    expect(container.textContent).toContain('Save or discard the financials draft');
    expect(container.querySelector<HTMLButtonElement>('.plan-item-right button')?.disabled).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
