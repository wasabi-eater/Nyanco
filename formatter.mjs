const opens = new Set(['(', '[', '{']);
const closes = new Set([')', ']', '}']);
const separators = new Set([',', ';', ';;']);

function spacing(left, right, gap) {
  if (opens.has(left.kind) || closes.has(right.kind) || separators.has(right.kind)) return '';
  if (right.kind === 'word' && right.value === ':') return '';
  if (left.kind === '#' && right.kind === '(') return '';
  if (left.kind === 'word' && ['.', '.?'].includes(left.value) && right.kind === '[') return '';
  if (right.kind === 'word' && ['..', '..='].includes(right.value)) return ' ';
  // Dot access and effect labels distinguish attached and separate tokens.
  if (!gap && right.kind === 'word' && /^[.@]/.test(right.value)) return '';
  return ' ';
}

export function formatSource(text, tokens, {tabSize = 4, insertSpaces = true, insertFinalNewline = false, trimFinalNewlines = false} = {}, reindent = true) {
  const lines = text.split(/(\r?\n)/), byLine = new Map(), protectedLines = new Set();
  for (const token of tokens) {
    if (token.endLine > token.line) {
      for (let line = token.line; line <= token.endLine; line++) protectedLines.add(line);
    }
    if (!byLine.has(token.line)) byLine.set(token.line, []);
    byLine.get(token.line).push(token);
  }
  const unit = insertSpaces ? ' '.repeat(Number.isInteger(tabSize) && tabSize > 0 && tabSize <= 32 ? tabSize : 4) : '\t';
  const levels = [0];
  for (let i = 0; i < lines.length; i += 2) {
    const line = i / 2 + 1, original = lines[i], terms = byLine.get(line) || [];
    if (!terms.length && !protectedLines.has(line) && /^\s*$/.test(original)) {
      lines[i] = '';
      continue;
    }
    if (!terms.length) continue;
    const indent = terms[0].col - 1;
    while (levels.at(-1) > indent) levels.pop();
    if (levels.at(-1) < indent) levels.push(indent);
    if (protectedLines.has(line)) continue;

    let formatted = reindent ? unit.repeat(levels.length - 1) : original.slice(0, indent);
    for (const [index, term] of terms.entries()) {
      if (index) {
        const previous = terms[index - 1], gap = original.slice(previous.endCol - 1, term.col - 1);
        formatted += /^[ \t]*$/.test(gap) ? spacing(previous, term, gap) : gap;
      }
      formatted += original.slice(term.col - 1, term.endCol - 1);
    }
    const suffix = original.slice(terms.at(-1).endCol - 1);
    if (suffix.trim()) formatted += '  ' + suffix.trimStart();
    lines[i] = formatted;
  }
  let result = lines.join('');
  const newline = lines.find((_, i) => i % 2 === 1) || '\n';
  if (trimFinalNewlines) result = result.replace(/(?:\r?\n)+$/, match => match.endsWith('\r\n') ? '\r\n' : '\n');
  if (insertFinalNewline && result && !result.endsWith('\n')) result += newline;
  return result;
}

// Position metadata and fresh names change when the same source is reparsed.
export function syntaxFingerprint(program, tokens) {
  const names = new Map();
  const position = new Set(['line','col','endLine','endCol','logicalLine','endLogicalLine','declarationCol']);
  const definitions = program.definitions;
  return JSON.stringify([tokens, definitions.initializers, [...definitions]], (key, value) => {
    if (position.has(key)) return undefined;
    if (typeof value === 'string' && /^@(stack|match|label|block)\d+$/.test(value)) {
      if (!names.has(value)) names.set(value, value.replace(/\d+$/, String(names.size)));
      return names.get(value);
    }
    return value;
  });
}
