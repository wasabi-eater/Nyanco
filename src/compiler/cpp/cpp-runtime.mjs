import {readFileSync} from 'node:fs';

// Read identifiers, not strings or comments. For a qualified name, only its
// first component can refer to a runtime fragment. Member names are retained
// conservatively, since generated code also calls out-of-line Machine methods.
const cppTokens = /\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|((?:[A-Za-z_]\w*::)*[A-Za-z_]\w*)/g;
function references(source) {
  const names = new Set(), standard = new Set();
  for (const [, token] of source.matchAll(cppTokens)) {
    if (!token) continue;
    const [root, member] = token.split('::');
    if (root === 'std' && member) standard.add(member);
    else names.add(root);
  }
  return {names, standard};
}

const headers = new Map(Object.entries({
  algorithm: 'equal find lexicographical_compare min pop_heap push_heap reverse sort stable_sort',
  any: 'any any_cast',
  array: 'array',
  bit: 'bit_cast',
  charconv: 'chars_format from_chars to_chars',
  cmath: 'abs fmod isfinite isnan pow',
  condition_variable: 'condition_variable',
  cstddef: 'size_t',
  cstdint: 'int64_t uint8_t uint32_t uint64_t',
  exception: 'current_exception exception exception_ptr rethrow_exception',
  functional: 'function',
  ios: 'ios',
  initializer_list: 'initializer_list',
  iostream: 'cerr cin cout',
  limits: 'numeric_limits',
  map: 'map',
  memory: 'make_shared shared_ptr dynamic_pointer_cast static_pointer_cast',
  mutex: 'lock_guard mutex unique_lock',
  optional: 'nullopt optional',
  span: 'span',
  stdexcept: 'runtime_error',
  string: 'getline string to_string',
  string_view: 'string_view',
  system_error: 'errc',
  thread: 'thread',
  tuple: 'get tuple',
  type_traits: 'conditional_t is_same_v',
  unordered_map: 'unordered_map',
  utility: 'move pair',
  variant: 'variant visit',
  vector: 'vector'
}).flatMap(([header, symbols]) => symbols.split(' ').map(symbol => [symbol,header])));

let runtime;
function parts(text, excluded = []) {
  const result = [];
  function add(source, when) {
    if (/^\/\/ @(?:if-runtime|end-runtime)\b/m.test(source))
      throw new Error('Unpaired C++ runtime condition');
    const refs = references(source);
    for (const name of excluded) refs.names.delete(name);
    result.push({text:source, when, refs});
  }
  let start = 0;
  for (const block of text.matchAll(/^\/\/ @if-runtime (\w+)\r?\n([\s\S]*?)^\/\/ @end-runtime\r?\n/gm)) {
    add(text.slice(start,block.index));
    add(block[2],block[1]);
    start = block.index + block[0].length;
  }
  add(text.slice(start));
  return result;
}
function loadRuntime() {
  if (runtime) return runtime;
  const source = readFileSync(new URL('./cpp-runtime.hpp.txt',import.meta.url),'utf8').replace('// @include hash-trie',readFileSync(new URL('./cpp-hash-trie.hpp.txt',import.meta.url),'utf8'));
  const sections = [...source.matchAll(/^\/\/ @runtime ([\w! ]+)\r?$/gm)];
  if (!sections.length) throw new Error('C++ runtime has no fragments');
  runtime = sections.map((section,i) => {
    const symbols = section[1].split(' ');
    const text = source.slice(section.index+section[0].length, sections[i+1]?.index).trim();
    const excluded = symbols.filter(symbol => symbol.startsWith('!')).map(symbol=>symbol.slice(1));
    return {symbols:symbols.filter(symbol => !symbol.startsWith('!')), parts:parts(text,excluded)};
  });
  return runtime;
}

export function emitCppRuntime(program, declarations) {
  const fragments = [...loadRuntime(), ...declarations.map(fragment => ({
    symbols:fragment.symbols, parts:parts(fragment.text)
  }))];
  const providers = new Map();
  for (const fragment of fragments) for (const symbol of fragment.symbols) {
    if (!providers.has(symbol)) providers.set(symbol,[]);
    providers.get(symbol).push(fragment);
  }
  const roots = references(program);
  const names = new Set(roots.names), standard = new Set(roots.standard);
  const used = new Set(), active = new Set(), waiting = new Map();
  function activate(part) {
    active.add(part);
    for (const dependency of part.refs.names) names.add(dependency);
    for (const symbol of part.refs.standard) standard.add(symbol);
  }
  // Set iteration includes entries added by each selected fragment.
  for (const name of names) {
    for (const part of waiting.get(name) || []) activate(part);
    for (const fragment of providers.get(name) || []) {
      if (used.has(fragment)) continue;
      used.add(fragment);
      for (const part of fragment.parts) {
        if (!part.when || names.has(part.when)) activate(part);
        else {
          if (!waiting.has(part.when)) waiting.set(part.when,[]);
          waiting.get(part.when).push(part);
        }
      }
    }
  }
  const includes = new Set();
  for (const symbol of standard) {
    const header = headers.get(symbol);
    if (!header) throw new Error('No C++ header registered for std::'+symbol);
    includes.add(header);
  }
  if (names.has('UINT32_C') || names.has('UINT64_C')) includes.add('cstdint');
  if (names.has('typeid')) includes.add('typeinfo');
  const render = group => group.filter(fragment=>used.has(fragment))
    .map(fragment=>fragment.parts.filter(part=>active.has(part)).map(part=>part.text).join('')).join('\n\n');
  return {
    includes:[...includes].sort().map(header => `#include <${header}>`).join('\n'),
    runtime:render(fragments.slice(0,runtime.length)),
    declarations:render(fragments.slice(runtime.length))
  };
}
