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
  type StringStream,
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
  { tag: [tags.bool, tags.null, tags.special(tags.variableName)], class: 'source-token-literal' },
  { tag: tags.keyword, class: 'source-token-keyword' },
  { tag: tags.function(tags.variableName), class: 'source-token-function' },
  { tag: tags.comment, class: 'source-token-comment' },
  { tag: tags.punctuation, class: 'source-token-punctuation' },
  { tag: tags.bracket, class: 'source-token-bracket' },
  ...parenthesisTags.map((tag, depth) => ({ tag, class: `source-bracket-${depth}` })),
]);

const parenthesisTokens = Object.fromEntries(
  parenthesisTags.map((tag, depth) => [`parenthesis${depth}`, tag]),
);

type SourceLanguage = 'json' | 'sexpr' | 'scad' | 'text';

export function sourceLanguageForFile(name: string): SourceLanguage {
  if (/\.(?:kicad_pro|kicad_prl|kicad_jobset|json)$/i.test(name)) return 'json';
  if (
    /\.(?:kicad_sch|kicad_pcb|kicad_sym|kicad_mod|kicad_dru|kicad_wks)$/i.test(name) ||
    /(?:^|\/)(?:sym|fp)-lib-table$/i.test(name)
  )
    return 'sexpr';
  if (/\.scad$/i.test(name)) return 'scad';
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
  tokenTable: parenthesisTokens,
});

const scadKeywords = new Set([
  'module',
  'function',
  'if',
  'else',
  'for',
  'let',
  'each',
  'assert',
  'echo',
  'include',
  'use',
]);
const scadNumber = /(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/iy;
const scadWord = /\$?\w+/y;

type ScadState = {
  frames: { bracket: string; indent: number }[];
  comment: boolean;
  string: boolean;
  path: boolean;
  open: boolean;
  lineCode: boolean;
  lineIndent: number;
};

function scadSticky(pattern: RegExp, stream: StringStream) {
  pattern.lastIndex = stream.pos;
  return pattern.exec(stream.string)?.[0] ?? '';
}

function closeScadComment(stream: StringStream) {
  while (!stream.eol()) {
    if (stream.match('*/')) return true;
    stream.next();
  }
  return false;
}

function closeScadString(stream: StringStream) {
  while (!stream.eol()) {
    const char = stream.next();
    if (char === '\\') stream.next();
    else if (char === '"') return true;
  }
  return false;
}

// Brackets indent from their opening line. Within a block, an unterminated
// statement (a module call chain such as `for () translate () cube();`)
// continues one unit past its previous line until `;` or a closed block.
const scadLanguage = StreamLanguage.define<ScadState>({
  name: 'OpenSCAD',
  startState: () => ({
    frames: [],
    comment: false,
    string: false,
    path: false,
    open: false,
    lineCode: false,
    lineIndent: 0,
  }),
  token(stream, state) {
    if (stream.sol()) state.lineCode = false;
    if (state.comment) {
      state.comment = !closeScadComment(stream);
      return 'comment';
    }
    if (state.string) {
      state.string = !closeScadString(stream);
      return 'string';
    }
    if (stream.eatSpace()) return null;
    if (stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match('/*')) {
      state.comment = !closeScadComment(stream);
      return 'comment';
    }
    const top = state.frames.at(-1);
    const statement = !top || top.bracket === '{';
    if (!state.lineCode) {
      state.lineCode = true;
      if (statement) state.lineIndent = stream.indentation();
    }
    const path = state.path;
    state.path = false;
    const char = stream.next()!;
    if (char === ')' || char === ']' || char === '}') {
      state.frames.pop();
      if (char === '}') state.open = false;
      return `parenthesis${state.frames.length % 3}`;
    }
    if (char === ';') {
      if (statement) state.open = false;
      return 'punctuation';
    }
    if (char === '{') {
      state.frames.push({ bracket: char, indent: stream.indentation() });
      state.open = false;
      return `parenthesis${(state.frames.length - 1) % 3}`;
    }
    if (statement) state.open = true;
    if (char === '(' || char === '[') {
      state.frames.push({ bracket: char, indent: stream.indentation() });
      return `parenthesis${(state.frames.length - 1) % 3}`;
    }
    if (char === '"') {
      state.string = !closeScadString(stream);
      return 'string';
    }
    if (char === '<' && path) {
      stream.match(/^[^>]*>?/);
      if (statement) state.open = false;
      return 'string';
    }
    if (char === ',') return 'punctuation';
    stream.backUp(1);
    // OpenSCAD lexes the longest match, so `2d_part` is an identifier.
    const number = scadSticky(scadNumber, stream);
    const word = scadSticky(scadWord, stream);
    if (!number && !word) {
      stream.next();
      return /[-+*/%^!<>=&|?:#.]/.test(char) ? 'operator' : null;
    }
    if (number.length >= word.length) {
      stream.pos += number.length;
      return 'number';
    }
    stream.pos += word.length;
    if (scadKeywords.has(word)) {
      state.path = word === 'include' || word === 'use';
      return 'keyword';
    }
    if (word === 'true' || word === 'false') return 'bool';
    if (word === 'undef') return 'null';
    if (word.startsWith('$')) return 'variableName.special';
    if (stream.match(/^\s*\(/, false)) return 'variableName.function';
    if (stream.match(/^\s*=(?!=)/, false)) return 'propertyName';
    return 'variableName';
  },
  indent(state, textAfter, context) {
    if (state.comment || state.string) return null;
    const top = state.frames.at(-1);
    if (top && /^[)\]}]/.test(textAfter)) return top.indent;
    if (top && top.bracket !== '{') return top.indent + context.unit;
    if (state.open) return state.lineIndent + (textAfter.startsWith('{') ? 0 : context.unit);
    return top ? top.indent + context.unit : 0;
  },
  languageData: {
    closeBrackets: { brackets: ['(', '[', '{', '"'] },
    indentOnInput: /^\s*[)\]}]/,
    commentTokens: { line: '//', block: { open: '/*', close: '*/' } },
  },
  tokenTable: parenthesisTokens,
});

const bracketFolding = foldService.of((state, lineStart, lineEnd) => {
  const tree = syntaxTree(state);
  for (let pos = lineStart; pos < lineEnd; pos++) {
    if (
      !/[([{]/.test(state.doc.sliceString(pos, pos + 1)) ||
      !tree.resolveInner(pos, 1).name.startsWith('parenthesis')
    )
      continue;
    const match = matchBrackets(state, pos, 1, {
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

type SourcePresentation = {
  lineNumbers: boolean;
  whitespace: boolean;
  wordWrap: boolean;
};

const defaultSourcePresentation: SourcePresentation = {
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
    language === 'json'
      ? json()
      : language === 'sexpr'
        ? [kicadLanguage, bracketFolding]
        : language === 'scad'
          ? [scadLanguage, bracketFolding]
          : [],
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
