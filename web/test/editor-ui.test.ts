// @vitest-environment jsdom
import { act, createElement, forwardRef, useImperativeHandle, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../src/state/session', () => ({ useSession: () => session.value, MIN_PASSWORD_LENGTH: 8 }));
vi.mock('../src/ui/TomlEditor', () => ({
  TomlEditor: forwardRef(function MockEditor(props: { value: string; onChange: (value: string) => void; ariaLabel: string }, ref) {
    useImperativeHandle(ref, () => ({ jumpToLine: vi.fn(), insert: vi.fn(), undo: vi.fn(), redo: vi.fn(), search: vi.fn() }));
    return createElement('textarea', { value: props.value, 'aria-label': props.ariaLabel, onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => props.onChange(e.target.value) });
  }),
}));
import { Settings } from '../src/ui/Settings';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it('downloads the displayed draft without changing the saved snapshot', async () => {
  const snapshot = { settingsToml: 'saved = true\n', financialsToml: '' };
  const downloads: Blob[] = [];
  const createUrl = vi.fn((blob: Blob) => { downloads.push(blob); return 'blob:test'; });
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() }));
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  function Harness() {
    const [drafts, setDrafts] = useState<{ settings: string | null; financials: string | null }>({ settings: 'draft = true\n', financials: null });
    session.value = { snapshot, isSample: false, drafts, setDraft: (kind: 'settings' | 'financials', text: string) => setDrafts((old) => ({ ...old, [kind]: text })) };
    return createElement(MemoryRouter, null, createElement(Settings));
  }
  const readBlob = (blob: Blob) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
  try {
    await act(async () => root.render(createElement(Harness)));
    const pane = container.querySelector<HTMLElement>('.pane')!;
    const button = (label: string) => Array.from(pane.querySelectorAll('button')).find((el) => el.textContent === label)!;
    expect(pane.textContent).toContain('Unsaved draft');
    await act(async () => button('Download').click());
    expect(await readBlob(downloads[0])).toBe('draft = true\n');
    expect(snapshot.settingsToml).toBe('saved = true\n');
    await act(async () => button('Clear').click());
    await act(async () => button('Download').click());
    expect(await readBlob(downloads[1])).toBe('');
    expect(snapshot.settingsToml).toBe('saved = true\n');
    expect(click).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    click.mockRestore();
    vi.unstubAllGlobals();
  }
});
