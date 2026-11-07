import {readFileSync} from 'node:fs';

// Run after runtime selection and coroutine lowering. Never rewrite user
// strings or comments, and never let local counters enter the threaded ABI.
export function lowerCppRc(source, mode) {
  if (!['local','shared'].includes(mode)) throw new Error('referenceCounting must be local or shared');
  if (mode === 'shared') return source;
  const identifiers = /\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|((?:[A-Za-z_]\w*::)*[A-Za-z_]\w*)/g;
  const replacements = new Map([
    ['std::shared_ptr','Rc'], ['std::make_shared','makeRc'],
    ['std::static_pointer_cast','staticRcCast'], ['std::dynamic_pointer_cast','dynamicRcCast']
  ]);
  let used = false;
  source = source.replace(identifiers, (text, identifier) => {
    if (identifier === 'std::thread') throw new Error('Local reference counting requires single-threaded C++ output (enable effectCoroutines)');
    if (!replacements.has(identifier)) return text;
    used = true; return replacements.get(identifier);
  });
  if (!used) return source;
  const runtime = readFileSync(new URL('./cpp-rc.hpp.txt', import.meta.url), 'utf8');
  return source.replace('namespace nyanco {', '#include <cstddef>\n#include <type_traits>\n#include <utility>\nnamespace nyanco {\n' + runtime);
}
