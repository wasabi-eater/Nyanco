import {VM, format, formatWarning} from './runtime/language.mjs';
import {compileModule} from './runtime/modules.mjs';
import {setVirtualFiles} from './runtime/browser-platform.mjs';

export function execute(source, input, emit, files = {}) {
  const lines = input ? input.split(/\r?\n/) : [];
  let cursor = 0, budget = 32000, events = 0;
  function write(kind, value) {
    if (budget <= 0 || ++events > 500) throw new Error('出力が上限に達しました');
    const message = String(value);
    emit({kind, text:message.slice(0,budget)});
    budget -= message.length + 1;
  }
  const overlays = new Map(Object.entries({...files,'/sample.nyan':source}));
  setVirtualFiles(Object.fromEntries(overlays));
  const program = compileModule('/sample.nyan',{overlays});
  for (const warning of program.warnings) write('warning',formatWarning(warning));
  const vm = new VM({
    ...program,
    input: () => lines[cursor++] ?? '',
    output: line => write('output',line),
    warning: warning => write('warning',formatWarning(warning)),
    maxSteps: 50000,
  });
  const stack = vm.evaluate('main');
  if (stack.length) write('stack',format(stack));
}