import { EditorState, type Extension, type Range } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  type DecorationSet,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightWhitespace,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import {
  bracketMatching,
  codeFolding,
  foldGutter,
  foldService,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
  syntaxTree,
  StreamLanguage,
  matchBrackets,
} from '@codemirror/language';
import { json } from '@codemirror/lang-json';
import { defaultKeymap, history, historyKeymap, indentWithTab, redo } from '@codemirror/commands';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { Tag, tags } from '@lezer/highlight';

const parenthesisTags = [Tag.define(), Tag.define(), Tag.define()];

const sourceColors = HighlightStyle.define([
  { tag: tags.propertyName, class: 'source-token-key' },
  { tag: tags.string, class: 'source-token-string' },
  { tag: tags.number, class: 'source-token-number' },
  { tag: [tags.bool, tags.null], class: 'source-token-literal' },
  { tag: tags.punctuation, class: 'source-token-punctuation' },
  { tag: tags.bracket, class: 'source-token-bracket' },
  ...parenthesisTags.map((tag, depth) => ({ tag, class: `source-bracket-${depth}` })),
]);

export type SourceLanguage = 'json' | 'sexpr' | 'text';

export function sourceLanguageForFile(name: string): SourceLanguage {
  if (/\.(?:kicad_pro|kicad_prl|kicad_jobset|json)$/i.test(name)) return 'json';
  if (
    /\.(?:kicad_sch|kicad_pcb|kicad_sym|kicad_mod|kicad_dru|kicad_wks)$/i.test(name) ||
    /(?:^|\/)(?:sym|fp)-lib-table$/i.test(name)
  )
    return 'sexpr';
  return 'text';
}

const kicadLanguage = StreamLanguage.define({
  name: 'KiCad',
  startState: () => ({ depth: 0, string: false, head: false }),
  token(stream, state) {
    if (!state.string && stream.eatSpace()) return null;
    if (state.string || stream.peek() === '"') {
      if (!state.string) stream.next();
      state.string = true;
      while (!stream.eol()) {
        const char = stream.next();
        if (char === '\\') stream.next();
        else if (char === '"') {
          state.string = false;
          break;
        }
      }
      state.head = false;
      return 'string';
    }
    const char = stream.next();
    if (char === '(') {
      const depth = state.depth++;
      state.head = true;
      return `parenthesis${depth % 3}`;
    }
    if (char === ')') {
      state.depth = Math.max(0, state.depth - 1);
      state.head = false;
      return `parenthesis${state.depth % 3}`;
    }
    if (char === '#' || char === ';') {
      stream.skipToEnd();
      return 'comment';
    }
    stream.eatWhile(/[^\s()";]/);
    const head = state.head;
    state.head = false;
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(stream.current())) return 'number';
    if (/^(?:yes|no|true|false)$/.test(stream.current())) return 'bool';
    return head ? 'propertyName' : 'variableName';
  },
  indent: (state, textAfter, context) =>
    state.string
      ? null
      : Math.max(0, state.depth - (textAfter.trimStart().startsWith(')') ? 1 : 0)) * context.unit,
  languageData: {
    closeBrackets: { brackets: ['(', '"'] },
    indentOnInput: /^\s*\)/,
    commentTokens: { line: '#' },
  },
  tokenTable: Object.fromEntries(parenthesisTags.map((tag, depth) => [`parenthesis${depth}`, tag])),
});

const kicadFolding = foldService.of((state, lineStart, lineEnd) => {
  const tree = syntaxTree(state);
  for (let pos = lineStart; pos < lineEnd; pos++) {
    if (
      state.doc.sliceString(pos, pos + 1) !== '(' ||
      !tree.resolveInner(pos, 1).name.startsWith('parenthesis')
    )
      continue;
    const match = matchBrackets(state, pos, 1, {
      brackets: '()',
      maxScanDistance: state.doc.length,
    });
    if (match?.matched && match.end && match.end.from > lineEnd)
      return { from: pos + 1, to: match.end.from };
  }
  return null;
});

// Decorations cover only rendered ranges. Syntax nodes distinguish structural
// brackets from brackets inside strings, including escaped embedded KiCad text.
export function sourceDecorations(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
) {
  const marks: Range<Decoration>[] = [];
  const lines = new Set<number>();
  for (const { from, to } of ranges) {
    for (let pos = state.doc.lineAt(from).from; pos <= to;) {
      const line = state.doc.lineAt(pos);
      if (!lines.has(line.from)) {
        lines.add(line.from);
        const whitespace = /^[ \t]+/.exec(line.text)?.[0] ?? '';
        let columns = 0;
        for (const char of whitespace) columns += char === '\t' ? 2 - (columns % 2) : 1;
        if (columns)
          marks.push(
            Decoration.line({
              class: 'source-indent-guides',
              attributes: { style: `--source-indent-width: ${columns}ch` },
            }).range(line.from),
          );
      }
      if (line.to === state.doc.length) break;
      pos = line.to + 1;
    }
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        if (!['{', '}', '[', ']'].includes(node.name) || node.from < from || node.to > to) return;
        let depth = -1;
        for (let parent = node.node.parent; parent; parent = parent.parent) {
          if (parent.name === 'Object' || parent.name === 'Array') depth++;
        }
        marks.push(
          Decoration.mark({ class: `source-bracket-${Math.max(depth, 0) % 3}` }).range(
            node.from,
            node.to,
          ),
        );
      },
    });
  }
  return Decoration.set(marks, true);
}

const structure = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = sourceDecorations(view.state, view.visibleRanges);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = sourceDecorations(update.state, update.view.visibleRanges);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

export type SourcePresentation = {
  lineNumbers: boolean;
  whitespace: boolean;
  wordWrap: boolean;
};

export const defaultSourcePresentation: SourcePresentation = {
  lineNumbers: true,
  whitespace: true,
  wordWrap: false,
};

export function sourcePresentationExtensions(
  options: SourcePresentation = defaultSourcePresentation,
) {
  return [
    options.lineNumbers ? lineNumbers() : [],
    options.whitespace ? highlightWhitespace() : [],
    options.wordWrap ? EditorView.lineWrapping : [],
  ];
}

export function sourceExtensions(
  presentation: Extension = sourcePresentationExtensions(),
  fileName = 'project.kicad_pro',
) {
  const language = sourceLanguageForFile(fileName);
  return [
    language === 'json' ? json() : language === 'sexpr' ? [kicadLanguage, kicadFolding] : [],
    history(),
    presentation,
    codeFolding({
      placeholderDOM(view, onclick) {
        const placeholder = view.dom.ownerDocument.createElement('span');
        placeholder.textContent = '…';
        placeholder.className = 'cm-foldPlaceholder';
        placeholder.setAttribute('aria-label', view.state.phrase('folded code'));
        placeholder.setAttribute('aria-description', view.state.phrase('unfold'));
        placeholder.title = view.state.phrase('unfold');
        placeholder.onclick = onclick;
        return placeholder;
      },
    }),
    foldGutter({
      markerDOM(open) {
        const marker = document.createElement('span');
        marker.textContent = open ? '⌄' : '›';
        marker.setAttribute('aria-label', open ? 'Fold line' : 'Unfold line');
        marker.title = open ? 'Fold line' : 'Unfold line';
        return marker;
      },
    }),
    drawSelection(),
    dropCursor(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    indentOnInput(),
    indentUnit.of('  '),
    EditorState.tabSize.of(2),
    bracketMatching(),
    closeBrackets(),
    syntaxHighlighting(sourceColors),
    structure,
    keymap.of([
      { key: 'Mod-Shift-z', run: redo, preventDefault: true },
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      indentWithTab,
    ]),
    EditorView.contentAttributes.of({
      'aria-label': 'Project file source',
      'aria-multiline': 'true',
      spellcheck: 'false',
      autocapitalize: 'off',
      autocorrect: 'off',
    }),
  ];
}
