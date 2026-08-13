import type { ReactNode } from 'react';

type CodeTokenKind =
  | 'attribute'
  | 'builtin'
  | 'comment'
  | 'constant'
  | 'function'
  | 'keyword'
  | 'number'
  | 'operator'
  | 'plain'
  | 'property'
  | 'string'
  | 'tag'
  | 'type';

type CodeToken = {
  kind: CodeTokenKind;
  text: string;
};

type LanguageFamily = 'css' | 'javascript' | 'json' | 'markup' | 'python' | 'shell' | 'sql' | 'generic';

const KEYWORDS: Record<LanguageFamily, ReadonlySet<string>> = {
  css: new Set(['@charset', '@font-face', '@import', '@keyframes', '@media', '@supports', 'from', 'to']),
  javascript: new Set([
    'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
    'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'from', 'function', 'if', 'import',
    'in', 'instanceof', 'let', 'new', 'of', 'return', 'static', 'super', 'switch', 'this', 'throw',
    'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'interface', 'implements', 'private',
    'protected', 'public', 'type', 'enum', 'namespace', 'declare', 'keyof', 'readonly', 'is',
  ]),
  json: new Set([]),
  markup: new Set([]),
  python: new Set([
    'and', 'as', 'assert', 'async', 'await', 'break', 'case', 'class', 'continue', 'def', 'del', 'elif',
    'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'match',
    'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
  ]),
  shell: new Set(['case', 'do', 'done', 'elif', 'else', 'esac', 'fi', 'for', 'function', 'if', 'in', 'then', 'until', 'while']),
  sql: new Set([
    'alter', 'and', 'as', 'asc', 'begin', 'between', 'by', 'case', 'create', 'delete', 'desc', 'distinct',
    'drop', 'else', 'end', 'from', 'group', 'having', 'in', 'insert', 'into', 'is', 'join', 'left', 'like',
    'limit', 'not', 'null', 'on', 'or', 'order', 'outer', 'right', 'select', 'set', 'table', 'then',
    'union', 'update', 'values', 'when', 'where', 'with',
  ]),
  generic: new Set([
    'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'else', 'extends',
    'finally', 'for', 'from', 'function', 'if', 'import', 'in', 'interface', 'let', 'new', 'of', 'return',
    'static', 'switch', 'this', 'throw', 'try', 'type', 'var', 'while',
  ]),
};

const BUILTINS: Record<LanguageFamily, ReadonlySet<string>> = {
  css: new Set([]),
  javascript: new Set(['Array', 'Boolean', 'Date', 'Error', 'JSON', 'Math', 'Object', 'Promise', 'RegExp', 'Set', 'String', 'console', 'document', 'window']),
  json: new Set([]),
  markup: new Set([]),
  python: new Set([
    'bool', 'dict', 'enumerate', 'float', 'int', 'len', 'list', 'open', 'print', 'range', 'set', 'str',
    'sum', 'tuple', 'zip', 'input', 'super', 'self',
  ]),
  shell: new Set(['echo', 'cd', 'export', 'printf', 'pwd', 'read', 'source', 'test']),
  sql: new Set(['avg', 'count', 'coalesce', 'max', 'min', 'sum']),
  generic: new Set(['Array', 'Boolean', 'Date', 'JSON', 'Math', 'Object', 'Promise', 'String', 'print']),
};

const CONSTANTS = new Set(['False', 'None', 'True', 'false', 'null', 'true', 'undefined', 'NaN', 'Infinity']);
const OPERATORS = [
  '===', '!==', '>>>', '**=', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '++', '--', '+=', '-=',
  '*=', '/=', '%=', '**', '//', '&&', '||', '??', '?.', '::', ':=', '->', '<<', '>>', '+', '-', '*', '/',
  '%', '=', '<', '>', '!', '&', '|', '^', '~', '?', ':',
];

function languageFamily(language: string): LanguageFamily {
  const normalized = language.toLocaleLowerCase().replace(/[^a-z]/g, '');
  if (['py', 'python', 'python3'].includes(normalized)) return 'python';
  if (['js', 'javascript', 'jsx', 'ts', 'typescript', 'tsx'].includes(normalized)) return 'javascript';
  if (['json', 'jsonc'].includes(normalized)) return 'json';
  if (['html', 'htm', 'xml', 'svg', 'jsx'].includes(normalized)) return 'markup';
  if (['css', 'scss', 'less'].includes(normalized)) return 'css';
  if (['bash', 'shell', 'sh', 'zsh', 'terminal'].includes(normalized)) return 'shell';
  if (['sql', 'mysql', 'postgresql', 'postgres'].includes(normalized)) return 'sql';
  return 'generic';
}

function isIdentifierStart(character: string | undefined) {
  return Boolean(character && /[A-Za-z_$]/.test(character));
}

function isIdentifierPart(character: string | undefined) {
  return Boolean(character && /[A-Za-z0-9_$]/.test(character));
}

function nextNonWhitespace(code: string, start: number) {
  let cursor = start;
  while (cursor < code.length && /\s/.test(code[cursor])) cursor += 1;
  return cursor;
}

function previousNonWhitespace(code: string, start: number) {
  let cursor = start - 1;
  while (cursor >= 0 && /\s/.test(code[cursor])) cursor -= 1;
  return cursor;
}

function readString(code: string, start: number) {
  const quote = code[start];
  const triple = code.slice(start, start + 3) === quote.repeat(3);
  let cursor = start + (triple ? 3 : 1);
  while (cursor < code.length) {
    if (code[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (triple ? code.slice(cursor, cursor + 3) === quote.repeat(3) : code[cursor] === quote) {
      return cursor + (triple ? 3 : 1);
    }
    cursor += 1;
  }
  return code.length;
}

function readLineComment(code: string, start: number) {
  const end = code.indexOf('\n', start);
  return end === -1 ? code.length : end;
}

function readBlockComment(code: string, start: number, closing: string) {
  const end = code.indexOf(closing, start + 2);
  return end === -1 ? code.length : end + closing.length;
}

function pushToken(tokens: CodeToken[], text: string, kind: CodeTokenKind = 'plain') {
  if (!text) return;
  const previous = tokens[tokens.length - 1];
  if (previous?.kind === kind) {
    previous.text += text;
  } else {
    tokens.push({ kind, text });
  }
}

function tokenize(code: string, language: string): CodeToken[] {
  const family = languageFamily(language);
  const keywords = KEYWORDS[family];
  const builtins = BUILTINS[family];
  const tokens: CodeToken[] = [];
  let cursor = 0;
  let previousWord = '';
  let inMarkupTag = false;
  let markupExpectsTagName = false;

  while (cursor < code.length) {
    const character = code[cursor];

    if (/\s/.test(character)) {
      const start = cursor;
      while (cursor < code.length && /\s/.test(code[cursor])) cursor += 1;
      pushToken(tokens, code.slice(start, cursor));
      continue;
    }

    if (family === 'markup' && code.startsWith('<!--', cursor)) {
      const end = readBlockComment(code, cursor, '-->');
      pushToken(tokens, code.slice(cursor, end), 'comment');
      cursor = end;
      continue;
    }

    if (code.startsWith('/*', cursor)) {
      const end = readBlockComment(code, cursor, '*/');
      pushToken(tokens, code.slice(cursor, end), 'comment');
      cursor = end;
      continue;
    }

    if (code.startsWith('//', cursor) || (family === 'sql' && code.startsWith('--', cursor)) ||
      ((family === 'python' || family === 'shell' || family === 'generic') && character === '#')) {
      const end = readLineComment(code, cursor);
      pushToken(tokens, code.slice(cursor, end), 'comment');
      cursor = end;
      continue;
    }

    if (family === 'markup' && character === '<') {
      pushToken(tokens, character, 'operator');
      cursor += 1;
      inMarkupTag = true;
      markupExpectsTagName = true;
      if (code[cursor] === '/') {
        pushToken(tokens, '/', 'operator');
        cursor += 1;
      }
      continue;
    }

    if (family === 'markup' && inMarkupTag && character === '>') {
      pushToken(tokens, character, 'operator');
      cursor += 1;
      inMarkupTag = false;
      markupExpectsTagName = false;
      continue;
    }

    if (character === '"' || character === "'" || character === '`') {
      const end = readString(code, cursor);
      const after = nextNonWhitespace(code, end);
      const kind = after < code.length && code[after] === ':' ? 'property' : 'string';
      pushToken(tokens, code.slice(cursor, end), kind);
      cursor = end;
      continue;
    }

    if (/[0-9]/.test(character) && (cursor === 0 || !isIdentifierPart(code[cursor - 1]))) {
      const match = code.slice(cursor).match(/^(?:0[xob][\da-f]+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?n?)/i);
      if (match) {
        pushToken(tokens, match[0], 'number');
        cursor += match[0].length;
        continue;
      }
    }

    if (isIdentifierStart(character)) {
      const start = cursor;
      cursor += 1;
      while (cursor < code.length && isIdentifierPart(code[cursor])) cursor += 1;
      const word = code.slice(start, cursor);
      const before = previousNonWhitespace(code, start);
      const after = nextNonWhitespace(code, cursor);
      let kind: CodeTokenKind = 'plain';

      if (family === 'markup' && inMarkupTag) {
        kind = markupExpectsTagName ? 'tag' : 'attribute';
        markupExpectsTagName = false;
      } else if (CONSTANTS.has(word)) {
        kind = 'constant';
      } else if (keywords.has(word) || (family === 'sql' && keywords.has(word.toLocaleLowerCase()))) {
        kind = 'keyword';
      } else if (builtins.has(word)) {
        kind = 'builtin';
      } else if (previousWord === 'def' || previousWord === 'function') {
        kind = 'function';
      } else if (previousWord === 'class' || previousWord === 'interface' || previousWord === 'type' || previousWord === 'enum' || previousWord === 'new') {
        kind = 'type';
      } else if (after < code.length && code[after] === '(') {
        kind = 'function';
      } else if (before >= 0 && code[before] === '.') {
        kind = 'property';
      } else if (after < code.length && code[after] === ':' && (family === 'json' || family === 'javascript')) {
        kind = 'property';
      }

      pushToken(tokens, word, kind);
      previousWord = word;
      continue;
    }

    const operator = OPERATORS.find((candidate) => code.startsWith(candidate, cursor));
    if (operator) {
      pushToken(tokens, operator, 'operator');
      cursor += operator.length;
      continue;
    }

    pushToken(tokens, character);
    cursor += 1;
  }

  return tokens;
}

export function HighlightedCode({ code, language }: { code: string; language: string }): ReactNode {
  return tokenize(code, language).map((token, index) => token.kind === 'plain'
    ? token.text
    : <span className={`code-token code-token--${token.kind}`} key={`${token.kind}-${index}`}>{token.text}</span>);
}

export function CodeBlock({ code, language, caption }: { code: string; language: string; caption?: string }) {
  return (
    <figure className="lesson-rich-block lesson-rich-block--code">
      <figcaption><span>{language}</span>{caption && <span>{caption}</span>}</figcaption>
      <pre><code><HighlightedCode code={code} language={language} /></code></pre>
    </figure>
  );
}
