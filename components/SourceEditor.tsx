'use client';

import {
  Check,
  ChevronRight,
  Code2,
  Copy,
  FileCode2,
  Folder,
  FolderOpen,
  LockKeyhole,
  RefreshCw,
} from 'lucide-react';
import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from 'react';
import { Compartment, EditorSelection, EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { sourceExtensions, sourceLanguageForFile } from '@/lib/source-editor';
import EditorStatusBar from './EditorStatusBar';
import InspectorResize, { type InspectorSize } from './InspectorResize';
import ProjectPdfPreview from './ProjectPdfPreview';

type SourceFileNode = {
  name: string;
  path: string;
  children?: SourceFileNode[];
  readOnly?: boolean;
  observation?: boolean;
};

const sourceFileNameOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function compareSourceNodes(a: SourceFileNode, b: SourceFileNode) {
  return Number(!!b.children) - Number(!!a.children) || sourceFileNameOrder.compare(a.name, b.name);
}

function SourceFileList({
  files,
  activeFile,
  onSelectFile,
  directories,
}: {
  files: readonly { name: string; readOnly?: boolean; observation?: boolean }[];
  directories: readonly string[];
  activeFile: string;
  onSelectFile?: (name: string) => void;
}) {
  const tree = useMemo(() => {
    const roots: SourceFileNode[] = [];
    const folders = new Map<string, SourceFileNode>();
    for (const file of [
      ...directories.map((name) => ({ name, directory: true, readOnly: true, observation: true })),
      ...files,
    ]) {
      const directory = 'directory' in file;
      const segments = file.name.split('/');
      let children = roots;
      for (let index = 0; index < segments.length - (directory ? 0 : 1); index++) {
        const path = segments.slice(0, index + 1).join('/');
        let folder = folders.get(path);
        if (!folder) {
          folder = { name: segments[index], path, children: [] };
          folders.set(path, folder);
          children.push(folder);
        }
        children = folder.children!;
        folder.readOnly = (folder.readOnly ?? true) && !!file.readOnly;
        folder.observation = (folder.observation ?? true) && !!file.observation;
      }
      if (!directory)
        children.push({
          name: segments.at(-1)!,
          path: file.name,
          readOnly: 'readOnly' in file && file.readOnly,
          observation: file.observation,
        });
    }
    roots.sort(compareSourceNodes);
    for (const folder of folders.values()) folder.children!.sort(compareSourceNodes);
    return { roots, folders };
  }, [files, directories]);
  const [expandedFolders, setExpandedFolders] = useState<ReadonlySet<string>>(() => new Set());
  const previousActiveFile = useRef(activeFile);

  useEffect(() => {
    setExpandedFolders((current) => {
      const retained = new Set([...current].filter((path) => tree.folders.has(path)));
      return retained.size === current.size ? current : retained;
    });
  }, [tree]);

  useEffect(() => {
    if (previousActiveFile.current === activeFile) return;
    previousActiveFile.current = activeFile;
    setExpandedFolders((current) => {
      const next = new Set(current);
      const segments = activeFile.split('/');
      for (let index = 1; index < segments.length; index++)
        next.add(segments.slice(0, index).join('/'));
      return next.size === current.size ? current : next;
    });
  }, [activeFile]);

  const renderNodes = (nodes: SourceFileNode[]): ReactNode =>
    nodes.map((node) => {
      if (!node.children)
        return (
          <li key={node.path} data-agent-private={node.readOnly || node.observation || undefined}>
            <button
              type="button"
              className={`source-editor-file${node.path === activeFile ? ' is-active' : ''}`}
              data-source-file={node.path}
              data-agent-private={node.readOnly || node.observation || undefined}
              aria-label={node.path}
              aria-description={node.readOnly ? `${node.path} (read-only)` : node.path}
              aria-current={node.path === activeFile ? 'page' : undefined}
              onClick={() => onSelectFile?.(node.path)}
            >
              {node.readOnly ? (
                <LockKeyhole size={15} aria-hidden="true" />
              ) : (
                <FileCode2 size={15} aria-hidden="true" />
              )}
              <span>{node.name}</span>
            </button>
          </li>
        );
      const expanded = expandedFolders.has(node.path);
      const FolderIcon = expanded ? FolderOpen : Folder;
      return (
        <li key={node.path} data-agent-private={node.readOnly || node.observation || undefined}>
          <button
            type="button"
            className="source-editor-file source-editor-folder"
            data-source-folder={node.path}
            aria-label={node.path}
            aria-expanded={expanded}
            onClick={() =>
              setExpandedFolders((current) => {
                const next = new Set(current);
                if (next.has(node.path)) next.delete(node.path);
                else next.add(node.path);
                return next;
              })
            }
          >
            <ChevronRight className="source-editor-folder-chevron" size={12} aria-hidden="true" />
            <FolderIcon size={15} aria-hidden="true" />
            <span>{node.name}</span>
          </button>
          <ul className="source-editor-tree-children" hidden={!expanded}>
            {renderNodes(node.children)}
          </ul>
        </li>
      );
    });

  return <ul className="source-editor-tree">{renderNodes(tree.roots)}</ul>;
}

function SourceEditor({
  value,
  pending,
  error,
  onChange,
  onApply,
  applyLabel = 'Apply',
  onCopy,
  status,
  listAction,
  trailingAction,
  active = true,
  visible = true,
  files,
  activeFile,
  onSelectFile,
  directories = [],
  fileError = '',
  onRefreshFiles,
}: {
  value: string;
  pending: boolean;
  error: string;
  onChange: (value: string) => void;
  onApply: () => void;
  applyLabel?: string;
  onCopy: () => void;
  status?: string;
  listAction?: ReactNode;
  trailingAction?: ReactNode;
  active?: boolean;
  visible?: boolean;
  files?: readonly {
    name: string;
    source: string;
    encoding?: 'latin1';
    readOnly?: boolean;
    observation?: boolean;
    pdf?: { fileId: string; id: string };
    previewStatus?: string;
  }[];
  directories?: readonly string[];
  fileError?: string;
  onRefreshFiles?: () => void;
  activeFile?: string;
  onSelectFile?: (name: string) => void;
}) {
  const fileName = activeFile ?? files?.[0]?.name ?? '';
  const selectedFile = files?.find((file) => file.name === fileName);
  const readOnly = !!selectedFile?.readOnly;
  const fileLabel = fileName;
  const pdf = selectedFile?.pdf;
  const language = sourceLanguageForFile(fileName);
  const format = pdf
    ? 'PDF'
    : language === 'json'
      ? 'JSON'
      : language === 'sexpr'
        ? 'KiCad S-expression'
        : 'Text';
  const encoding =
    files?.find((file) => file.name === fileName)?.encoding === 'latin1' ? 'ISO-8859-1' : 'UTF-8';
  const errorId = useId();
  const host = useRef<HTMLDivElement>(null);
  const sourceContent = useRef<HTMLDivElement>(null);
  const fileList = useRef<HTMLDivElement>(null);
  const [fileListSize, setFileListSize] = useState<InspectorSize>({});
  const editor = useRef<EditorView | null>(null);
  const props = useRef({ value, onChange, fileName, readOnly });
  props.current = { value, onChange, fileName, readOnly };
  const displayedFile = useRef(fileName);
  const fileEditors = useRef(
    new Map<string, { state: EditorState; scroll: ReturnType<EditorView['scrollSnapshot']> }>(),
  );
  const accessibility = useRef(new Compartment());
  const extensions = useRef<(name: string) => Extension[]>(() => []);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });

  useEffect(() => {
    extensions.current = (name) => [
      sourceExtensions(undefined, name),
      accessibility.current.of([]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !props.current.readOnly)
          props.current.onChange(update.state.doc.toString());
        if (update.docChanged || update.selectionSet) {
          const head = update.state.selection.main.head;
          const line = update.state.doc.lineAt(head);
          setCursor({ line: line.number, column: head - line.from + 1 });
        }
      }),
    ];
    const view = new EditorView({
      doc: props.current.value,
      parent: host.current!,
      extensions: extensions.current(props.current.fileName),
    });
    editor.current = view;
    return () => {
      view.destroy();
      editor.current = null;
      fileEditors.current.clear();
    };
  }, []);

  useLayoutEffect(() => {
    if (!visible) return;
    const view = editor.current;
    if (!view) return;
    if (displayedFile.current !== fileName) {
      fileEditors.current.set(displayedFile.current, {
        state: view.state,
        scroll: view.scrollSnapshot(),
      });
      const cached = fileEditors.current.get(fileName);
      const state =
        cached?.state.doc.toString() === value
          ? cached.state
          : EditorState.create({ doc: value, extensions: extensions.current(fileName) });
      displayedFile.current = fileName;
      view.setState(state);
      // Restore after CodeMirror measures the new viewport. Assigning raw
      // scroll pixels here can drift when virtual line heights settle.
      if (cached?.state === state) view.dispatch({ effects: cached.scroll });
      if (cached?.state !== state) {
        view.scrollDOM.scrollTop = 0;
        view.scrollDOM.scrollLeft = 0;
      }
      const head = state.selection.main.head;
      const line = state.doc.lineAt(head);
      setCursor({ line: line.number, column: head - line.from + 1 });
      return;
    }
    if (view.state.doc.toString() === value) return;
    // Project Apply/Undo/Redo replaces the editor baseline. Typing echoes never
    // reset the editor or its local history, selection, composition, or scroll.
    const head = Math.min(view.state.selection.main.head, value.length);
    const state = EditorState.create({
      doc: value,
      selection: EditorSelection.cursor(head),
      extensions: extensions.current(fileName),
    });
    view.setState(state);
    const line = state.doc.lineAt(head);
    setCursor({ line: line.number, column: head - line.from + 1 });
  }, [value, fileName, visible]);

  useEffect(() => {
    if (!files) return;
    const names = new Set(files.map((file) => file.name));
    for (const name of fileEditors.current.keys()) {
      if (!names.has(name)) fileEditors.current.delete(name);
    }
    const observations = [...fileEditors.current.keys()].filter((name) =>
      files.some((file) => file.name === name && file.observation),
    );
    for (const name of observations.slice(0, -8)) fileEditors.current.delete(name);
  }, [files]);

  useEffect(() => {
    editor.current?.dispatch({
      effects: accessibility.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        EditorView.contentAttributes.of({
          'aria-invalid': String(Boolean(error)),
          ...(error ? { 'aria-describedby': errorId } : {}),
        }),
      ]),
    });
  }, [error, value, fileName, errorId, readOnly]);

  return (
    <section
      className="source-editor"
      aria-label="Project source"
      data-agent-private={selectedFile?.readOnly || undefined}
    >
      <header className="source-editor-toolbar">
        <span className="source-editor-title" aria-description={fileLabel || 'Project files'}>
          <Code2 size={17} aria-hidden="true" /> <span>{fileLabel || 'Project files'}</span>
        </span>
        <div className="source-editor-actions">
          <button
            type="button"
            className="tool-button"
            aria-label="Copy"
            title="Copy"
            disabled={!!pdf}
            onClick={onCopy}
          >
            <Copy size={17} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="tool-button"
            aria-label={applyLabel}
            title={applyLabel}
            disabled={!pending || readOnly}
            onClick={onApply}
          >
            <Check size={17} aria-hidden="true" />
          </button>
          {listAction}
          {trailingAction}
          {onRefreshFiles && (
            <button
              type="button"
              className="tool-button"
              aria-label="Refresh project files"
              title="Refresh project files"
              onClick={onRefreshFiles}
            >
              <RefreshCw size={17} aria-hidden="true" />
            </button>
          )}
        </div>
      </header>
      <div
        className="source-editor-content"
        ref={sourceContent}
        style={
          {
            '--source-files-width': fileListSize.width ? fileListSize.width + 'px' : undefined,
          } as CSSProperties
        }
      >
        {files && files.length > 0 && (
          <div className="source-editor-files" ref={fileList}>
            <nav aria-label="Project files">
              <span className="source-editor-files-title">
                <FolderOpen size={16} aria-hidden="true" /> Files
              </span>
              <SourceFileList
                files={files}
                directories={directories}
                activeFile={fileName}
                onSelectFile={onSelectFile}
              />
            </nav>
          </div>
        )}
        {files && files.length > 0 && (
          <InspectorResize
            target={fileList}
            size={fileListSize}
            onResize={setFileListSize}
            label="Source file list"
            minWidth={144}
            axes={['width']}
            horizontalAnchor="left"
            bounds={() => ({
              width: Math.max(0, (sourceContent.current?.clientWidth ?? 0) - 160),
              height: 0,
            })}
          />
        )}
        <div className="source-editor-code" ref={host} hidden={!!pdf} />
        {pdf && (
          <ProjectPdfPreview fileId={pdf.fileId} id={pdf.id} name={fileName} visible={visible} />
        )}
      </div>
      {error && (
        <p id={errorId} className="source-editor-error" role="alert">
          {error}
        </p>
      )}
      {fileError && (
        <p className="source-editor-error" role="alert" data-agent-private>
          {fileError}
        </p>
      )}
      <EditorStatusBar
        mode="Source"
        active={active && visible}
        coordinates={
          pdf ? undefined : (
            <>
              Ln {cursor.line}, Col {cursor.column}
            </>
          )
        }
        controls={
          pdf ? (
            <span className="status-format">PDF</span>
          ) : (
            <span className="status-format">
              Spaces: 2 <span aria-hidden="true">·</span> {format} <span aria-hidden="true">·</span>{' '}
              {encoding}
            </span>
          )
        }
        status={
          readOnly
            ? `${pdf ? 'PDF' : 'Read-only file'}${selectedFile?.previewStatus ? ' · ' + selectedFile.previewStatus : ''}${pending ? ' · Native edits pending' : ''}`
            : status
        }
      />
    </section>
  );
}

// The first hide still dismisses active controls. On reveal, the latest native
// files are synchronized before paint without rebuilding hidden CodeMirror state.
export default memo(
  SourceEditor,
  (previous, next) => previous.visible === false && next.visible === false,
);
