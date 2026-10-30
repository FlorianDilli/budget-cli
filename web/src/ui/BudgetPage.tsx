import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { parseFinancials } from '../domain/config';
import { SAMPLE_FINANCIALS } from '../domain/sample';
import { useSession } from '../state/session';
import { BudgetInspector } from './BudgetInspector';
import { TomlEditor, type TomlEditorHandle } from './TomlEditor';
import { SectionTabs, useSectionParam, type SectionItem } from './SectionTabs';
import { PreviewNotice } from './common';
import './budget-studio.css';

const symbols = ['[', ']', '[[', ']]', '{', '}', '"', "'", '=', '#', ',', 'Tab'];
type View = 'editor' | 'split' | 'budget';
const VIEWS = ['editor', 'split', 'budget'] as const;
const VIEW_ITEMS = [
  { id: 'editor', label: 'Editor' },
  { id: 'split', label: 'Split' },
  { id: 'budget', label: 'Visual Budget' },
] as const satisfies readonly SectionItem<View>[];

export function BudgetPage() {
  const session = useSession();
  const { snapshot, financials, drafts, isSample } = session;
  // Narrow screens default to the visual budget because the split layout does not fit.
  const [defaultView] = useState<View>(() => (window.innerWidth < 900 ? 'budget' : 'split'));
  const [view, setView] = useSectionParam<View>('view', VIEWS, defaultView);
  const [wrap, setWrap] = useState(true);
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [legacyDraft] = useState(() => {
    try { return localStorage.getItem('moonli_toml_content'); } catch { return null; }
  });
  const [jump, setJump] = useState<{ line: number } | null>(null);
  const editor = useRef<TomlEditorHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const draft = drafts.financials ?? (isSample ? SAMPLE_FINANCIALS : snapshot?.financialsToml ?? '');
  const parsed = useMemo(() => parseFinancials(draft), [draft]);
  const dirty = draft !== (snapshot?.financialsToml ?? '');
  const display = parsed.ok ? parsed.value : financials;
  const issue = parsed.ok ? null : parsed.issues[0];

  useEffect(() => { if (jump && view !== 'budget') editor.current?.jumpToLine(jump.line); }, [jump, view]);
  if (!snapshot) return null;

  const save = async () => {
    setSaving(true);
    setNotice('');
    try {
      const result = await session.saveFinancials(draft);
      setNotice(result.ok ? 'Saved to encrypted storage.' : 'Not saved. Fix the errors first.');
    } catch (error) {
      setNotice(`Not saved: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  };
  const load = async (file: File) => {
    try {
      session.setDraft('financials', await file.text());
      setNotice(`Loaded ${file.name} as an unsaved draft.`);
    } catch {
      setNotice('Could not read the file.');
    }
  };
  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void load(file);
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (file) void load(file);
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([draft], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'financials.toml';
    link.click();
    URL.revokeObjectURL(url);
  };

  return <div className="page budget-page">
    <header className="page-head budget-page-head">
      <h1>Budget</h1>
      <SectionTabs items={VIEW_ITEMS} value={view} onChange={setView} label="Budget view" />
    </header>
    <PreviewNotice isSample={isSample} />
  <section className={`budget-studio${view === 'budget' ? ' is-budget' : ''}`} onDragOver={(event) => event.preventDefault()} onDrop={onDrop} aria-label="Budget studio">
    <header className="studio-header">
      <div className="studio-actions">
        <button type="button" className="icon-button" aria-label="Open TOML file" title="Open TOML file" onClick={() => fileInput.current?.click()}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5h6l2 2h9v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" /><path d="M3.5 8.5v-2a2 2 0 0 1 2-2h3l2 2" /></svg>
        </button>
        <input ref={fileInput} type="file" accept=".toml,.txt,text/plain" hidden onChange={onFile} aria-label="Open financials TOML" />
        <button type="button" className="icon-button" aria-label="Download TOML file" title="Download TOML file" onClick={download}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5v11" /><path d="m7.5 10 4.5 4.5 4.5-4.5" /><path d="M4.5 16.5v3h15v-3" /></svg>
        </button>
      </div>
    </header>
    {(!parsed.ok || notice || legacyDraft !== null) && <div className="studio-status" role="status">{!parsed.ok && 'Invalid draft. Showing the saved budget.'}{notice && ` ${notice}`}<span className="studio-status-actions">{legacyDraft !== null && <button type="button" onClick={() => { if (window.confirm('Replace this draft with the previous standalone Budget draft? It remains stored separately in plaintext until you remove it from browser storage.')) { session.setDraft('financials', legacyDraft); setView('editor'); setNotice('Previous standalone draft loaded. Save to encrypt and apply it.'); } }}>Recover old draft</button>}</span></div>}
    <div className={`studio-panels studio-${view}`}>
      <div className="studio-editor" hidden={view === 'budget'}>
        <div className="studio-symbols" role="group" aria-label="Editor actions">
          <button type="button" onClick={() => session.setDraft('financials', '')}>Clear</button>
          <button type="button" onClick={() => void navigator.clipboard?.writeText(draft)}>Copy</button>
          {symbols.map((symbol) => <button type="button" key={symbol} onClick={() => editor.current?.insert(symbol === 'Tab' ? '\t' : symbol)}>{symbol}</button>)}
          <button type="button" onClick={() => editor.current?.undo()}>Undo</button>
          <button type="button" onClick={() => editor.current?.redo()}>Redo</button>
          <button type="button" onClick={() => editor.current?.search()}>Search</button>
          <button type="button" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>Wrap</button>
        </div>
        <TomlEditor ref={editor} value={draft} onChange={(text) => { session.setDraft('financials', text); setNotice(''); }} wrap={wrap} ariaLabel="financials.toml editor" />
        {issue && <div className="error-banner" role="alert"><span>{issue.line ? `Line ${issue.line}: ` : ''}{issue.message}</span>{issue.line > 0 && <button type="button" onClick={() => editor.current?.jumpToLine(issue.line)}>Jump to line</button>}</div>}
      </div>
      <div className="studio-inspector" hidden={view === 'editor'}>
        <BudgetInspector financials={display} onSourceLineClick={parsed.ok ? (line) => { setView(view === 'split' ? 'split' : 'editor'); setJump({ line }); } : undefined} />
      </div>
    </div>
    <footer className="studio-footer">
      <button type="button" className="primary" disabled={!dirty || !parsed.ok || saving} onClick={() => void save()}>{saving ? 'Saving' : 'Save'}</button>
      <button type="button" disabled={!dirty || saving} onClick={() => { session.setDraft('financials', isSample ? SAMPLE_FINANCIALS : snapshot.financialsToml); setNotice('Draft discarded.'); }}>Discard changes</button>
    </footer>
  </section>
  </div>;
}
