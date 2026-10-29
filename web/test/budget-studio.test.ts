// @vitest-environment jsdom
import { act, createElement, forwardRef, useImperativeHandle, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseFinancials } from '../src/domain/config';

const mocks = vi.hoisted(() => ({ session: {} as Record<string, unknown>, jump: vi.fn(), insert: vi.fn() }));
vi.mock('../src/state/session', () => ({ useSession: () => mocks.session }));
vi.mock('../src/ui/TomlEditor', () => ({
  TomlEditor: forwardRef(function MockEditor(props: { value: string; onChange: (value: string) => void; ariaLabel: string }, ref) {
    useImperativeHandle(ref, () => ({ jumpToLine: mocks.jump, insert: mocks.insert, undo: vi.fn(), redo: vi.fn(), search: vi.fn() }));
    return createElement('textarea', { value: props.value, 'aria-label': props.ariaLabel, onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => props.onChange(event.target.value) });
  }),
}));
import { BudgetPage } from '../src/ui/BudgetPage';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const saved = '[[recurring_transactions]]\ndescription = "Saved rent"\namount = -100\n';
const draft = '# draft\n[[recurring_transactions]]\ndescription = "Draft salary"\namount = 250\n';
const invalid = '[[recurring_transactions]]\ndescription = "Broken"\n';

let container: HTMLDivElement;
let root: Root;
let saveFinancials: ReturnType<typeof vi.fn>;
let setDraft: ReturnType<typeof vi.fn>;

function parsed(text: string) {
  const result = parseFinancials(text);
  if (!result.ok) throw new Error('Invalid test fixture');
  return result.value;
}

async function render(initialDraft: string | null = null) {
  function Harness() {
    const [savedText, setSavedText] = useState(saved);
    const [draftText, setDraftText] = useState(initialDraft);
    setDraft.mockImplementation((_kind: string, text: string) => setDraftText(text));
    saveFinancials.mockImplementation(async (text: string) => {
      setSavedText(text);
      return { ok: true };
    });
    mocks.session = {
      snapshot: { financialsToml: savedText }, financials: parsed(savedText), settings: { currencySymbol: 'USD' },
      drafts: { financials: draftText, settings: null }, isSample: false, setDraft, saveFinancials,
    };
    return createElement('div', null, createElement(BudgetPage), createElement('output', { 'data-testid': 'shared' }, parsed(savedText).recurring[0]?.description));
  }
  await act(async () => root.render(createElement(Harness)));
}

function button(text: string) {
  const result = Array.from(container.querySelectorAll('button')).find((element) => element.textContent?.trim() === text);
  if (!result) throw new Error(`Button not found: ${text}`);
  return result;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

async function edit(value: string) {
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  saveFinancials = vi.fn();
  setDraft = vi.fn();
  mocks.jump.mockReset();
  mocks.insert.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('native budget studio', () => {
  it('previews a valid editor draft without changing shared data until saved', async () => {
    await render();
    await edit(draft);
    expect(setDraft).toHaveBeenCalledWith('financials', draft);
    expect(container.querySelector('.budget-inspector')?.textContent).toContain('Draft salary');
    expect(container.querySelector('.budget-inspector')?.textContent).toContain('+$250.00');
    expect(container.querySelector('[data-testid=shared]')?.textContent).toBe('Saved rent');
    expect(container.querySelector('[role=status]')?.textContent).toContain('Unsaved preview');
    expect(button('Save').disabled).toBe(false);

    await click(button('Save'));
    expect(saveFinancials).toHaveBeenCalledOnce();
    expect(saveFinancials).toHaveBeenCalledWith(draft);
    expect(container.querySelector('[data-testid=shared]')?.textContent).toBe('Draft salary');
    expect(container.querySelector('[role=status]')?.textContent).toContain('Saved to encrypted storage.');
    expect(button('Save').disabled).toBe(true);
  });

  it('shows the saved budget and disables save and source navigation for an invalid draft', async () => {
    await render(invalid);
    expect(container.querySelector('[role=status]')?.textContent).toContain('Invalid draft. Showing the saved budget.');
    expect(container.querySelector('[role=alert]')?.textContent).toContain('Broken');
    expect(container.querySelector('.budget-inspector')?.textContent).toContain('Saved rent');
    expect(container.querySelector('.budget-inspector')?.textContent).not.toContain('Broken');
    expect(button('Save').disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('.bi-row')?.disabled).toBe(true);
    await click(button('Jump to line'));
    expect(mocks.jump).toHaveBeenCalledWith(1);
    expect(saveFinancials).not.toHaveBeenCalled();
  });

  it('navigates from a visual entry to its editor source and supports editor actions', async () => {
    await render(draft);
    await click(button('Visual Budget'));
    expect(container.querySelector<HTMLElement>('.studio-editor')?.hidden).toBe(true);
    await click(container.querySelector<HTMLButtonElement>('.bi-row')!);
    expect(button('Editor').getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector<HTMLElement>('.studio-editor')?.hidden).toBe(false);
    expect(container.querySelector<HTMLElement>('.studio-inspector')?.hidden).toBe(true);
    expect(mocks.jump).toHaveBeenCalledWith(2);
    await click(button('Tab'));
    expect(mocks.insert).toHaveBeenCalledWith('\t');
    await click(button('Discard changes'));
    expect(setDraft).toHaveBeenLastCalledWith('financials', saved);
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(saved);
  });
});
