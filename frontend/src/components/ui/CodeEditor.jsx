import { useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { yaml as yamlLang } from '@codemirror/lang-yaml';
import { json as jsonLang } from '@codemirror/lang-json';
import { EditorView } from '@codemirror/view';

/**
 * Shared read/write code editor (CodeMirror 6) for YAML/JSON config content —
 * patroni.yml and Patroni's dynamic-config JSON are the first two callers.
 * No other code-editor infrastructure exists anywhere in this app; this is
 * the one shared wrapper so both call sites (and any future one) look and
 * behave identically rather than each hand-rolling CodeMirror setup.
 */
export default function CodeEditor({
  value,
  onChange,
  language = 'yaml',
  readOnly = false,
  minHeight = '240px',
  maxHeight = '520px',
  placeholder,
}) {
  const extensions = useMemo(() => {
    const ext = [language === 'json' ? jsonLang() : yamlLang()];
    if (readOnly) ext.push(EditorView.editable.of(false));
    return ext;
  }, [language, readOnly]);

  return (
    <div className="rounded-control border border-border overflow-hidden text-[13px]">
      <CodeMirror
        value={value || ''}
        onChange={onChange}
        extensions={extensions}
        readOnly={readOnly}
        placeholder={placeholder}
        basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: !readOnly }}
        style={{ minHeight, maxHeight, overflow: 'auto' }}
        theme="light"
      />
    </div>
  );
}
