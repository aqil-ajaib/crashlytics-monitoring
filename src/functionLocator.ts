export interface LineRange {
  startLine: number;
  endLine: number;
}

/** Blanks out comments and string/char literals (keeping length and newlines) so braces and keywords inside them can't confuse the scanner below. */
function maskNonCode(src: string): string {
  const out = src.split('');
  let i = 0;

  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };

  while (i < src.length) {
    const two = src.slice(i, i + 2);

    if (two === '//') {
      let end = src.indexOf('\n', i);
      if (end === -1) end = src.length;
      blank(i, end);
      i = end;
    } else if (two === '/*') {
      let end = src.indexOf('*/', i + 2);
      end = end === -1 ? src.length : end + 2;
      blank(i, end);
      i = end;
    } else if (src.startsWith('"""', i)) {
      let end = src.indexOf('"""', i + 3);
      end = end === -1 ? src.length : end + 3;
      blank(i, end);
      i = end;
    } else if (src[i] === '"' || src[i] === "'") {
      const quote = src[i];
      let j = i + 1;
      while (j < src.length && src[j] !== quote && src[j] !== '\n') {
        j += src[j] === '\\' ? 2 : 1;
      }
      blank(i, j + 1);
      i = j + 1;
    } else {
      i++;
    }
  }

  return out.join('');
}

function matchingIndex(text: string, openIndex: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return i;
  }
  return -1;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
  return line;
}

/**
 * Finds where `functionName` is declared in a Kotlin/Java source file and how
 * far its body extends. Returns null unless there is exactly one declaration,
 * because with overloads or look-alikes we can't know which one crashed.
 */
export function locateFunction(source: string, fileName: string, functionName: string): LineRange | null {
  const code = maskNonCode(source);
  const isJava = fileName.endsWith('.java');

  const declaration = isJava
    ? new RegExp(`(?<![\\w.])[\\w<>\\[\\],.?]+\\s+${functionName}\\s*\\(`, 'g')
    : new RegExp(`\\bfun\\s+(?:<[^>]+>\\s*)?(?:[\\w.<>?,*]+\\.)?${functionName}\\s*\\(`, 'g');

  const candidates: { index: number; open: number }[] = [];
  for (const m of code.matchAll(declaration)) {
    const open = m.index! + m[0].length - 1;
    const close = matchingIndex(code, open, '(', ')');
    if (close === -1) continue;

    // Java calls look like declarations until you check for a body: "name(...) {".
    if (isJava && !/^\s*(?:throws\s+[\w.,\s]+)?\{/.test(code.slice(close + 1, close + 200))) continue;

    candidates.push({ index: m.index!, open });
  }

  if (candidates.length !== 1) return null;
  const { index, open } = candidates[0];
  const close = matchingIndex(code, open, '(', ')');

  // After the parameter list comes an optional return type, then either a
  // block body "{" or an expression body "=".
  const rest = code.slice(close + 1, close + 400);
  const bodyStart = rest.search(/[{=]/);
  if (bodyStart === -1 || /\b(?:fun|val|var|class|interface|object)\b/.test(rest.slice(0, bodyStart))) return null;

  const startLine = lineOf(code, index);

  if (rest[bodyStart] === '{') {
    const braceIndex = close + 1 + bodyStart;
    const braceClose = matchingIndex(code, braceIndex, '{', '}');
    if (braceClose === -1) return null;
    return { startLine, endLine: lineOf(code, braceClose) };
  }

  // Expression body: it continues over the following lines that are indented
  // deeper than the declaration.
  const lines = code.split('\n');
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const baseIndent = indentOf(lines[startLine - 1]);
  let endLine = startLine;
  for (let n = startLine; n < lines.length; n++) {
    if (lines[n].trim() === '') continue;
    if (indentOf(lines[n]) <= baseIndent) break;
    endLine = n + 1;
  }
  return { startLine, endLine };
}
