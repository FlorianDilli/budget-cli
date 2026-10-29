import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, highlightSpecialChars } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands';
import { search, searchKeymap, openSearchPanel } from '@codemirror/search';
import { StreamLanguage, bracketMatching, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { toml } from '@codemirror/legacy-modes/mode/toml';

export interface TomlEditorHandle {
  jumpToLine: (line: number) => void;
  undo: () => void;
  redo: () => void;
  search: () => void;
  insert: (text: string) => void;
}

interface Props {
  value: string;
  onChange: (text: string) => void;
  wrap: boolean;
  ariaLabel: string;
}

const tomlLang = StreamLanguage.define(toml);

export const TomlEditor = forwardRef<TomlEditorHandle, Props>(function TomlEditor({ value, onChange, wrap, ariaLabel }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const wrapComp = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightSpecialChars(),
          drawSelection(),
          history(),
          search({ top: true }),
          bracketMatching(),
          tomlLang,
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          wrapComp.current.of(wrap ? EditorView.lineWrapping : []),
          EditorView.contentAttributes.of({ 'aria-label': ariaLabel, spellcheck: 'false', autocapitalize: 'off' }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // The editor is created once; value/wrap changes are synced below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.dispatch({ effects: wrapComp.current.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    if (v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  useImperativeHandle(ref, () => ({
    jumpToLine(line: number) {
      const v = view.current;
      if (!v) return;
      const n = Math.min(Math.max(1, line), v.state.doc.lines);
      const l = v.state.doc.line(n);
      v.dispatch({ selection: { anchor: l.from, head: l.to }, scrollIntoView: true });
      v.focus();
    },
    undo() {
      if (view.current) undo(view.current);
    },
    redo() {
      if (view.current) redo(view.current);
    },
    search() {
      if (view.current) openSearchPanel(view.current);
    },
    insert(text: string) {
      const v = view.current;
      if (!v) return;
      const pos = v.state.selection.main;
      v.dispatch({ changes: { from: pos.from, to: pos.to, insert: text }, selection: { anchor: pos.from + text.length } });
      v.focus();
    },
  }), []);

  return <div className="toml-editor" ref={host} />;
});
