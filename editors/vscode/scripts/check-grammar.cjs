const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
// Use npm dev dependencies, or the exact tokenizer bundled with a local VS Code.
const load = name => require(process.env.NYANCO_TOKENIZER_MODULES
  ? path.join(process.env.NYANCO_TOKENIZER_MODULES, name) : name);
const textmate = load('vscode-textmate');
const oniguruma = load('vscode-oniguruma');

async function main() {
  const wasm = process.env.NYANCO_TOKENIZER_MODULES
    ? path.join(process.env.NYANCO_TOKENIZER_MODULES, 'vscode-oniguruma/release/onig.wasm')
    : require.resolve('vscode-oniguruma/release/onig.wasm');
  const bytes = fs.readFileSync(wasm);
  await oniguruma.loadWASM(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const root = path.resolve(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const grammarFile = path.join(root, manifest.contributes.grammars[0].path);
  const registry = new textmate.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: patterns => new oniguruma.OnigScanner(patterns),
      createOnigString: text => new oniguruma.OnigString(text)
    }),
    loadGrammar: async () => textmate.parseRawGrammar(fs.readFileSync(grammarFile, 'utf8'), grammarFile)
  });
  const grammar = await registry.loadGrammar('source.nyanco');
  const check = (source, fragment, scope) => {
    const index = source.indexOf(fragment);
    assert.ok(index >= 0);
    const tokens = grammar.tokenizeLine(source, textmate.INITIAL).tokens;
    const token = tokens.find(t => t.startIndex <= index && index < t.endIndex);
    assert.ok(token?.scopes.includes(scope), `${fragment}: expected ${scope}, got ${token?.scopes}`);
  };
  check('-- data "hello"', 'data', 'comment.line.double-dash.nyanco');
  check('data option \'a = Some \'a | None', 'data', 'keyword.declaration.nyanco');
  check('data option \'a = Some \'a | None', "'a", 'entity.name.type.parameter.nyanco');
  check("main = 'a'", "'a'", 'string.quoted.single.nyanco');
  check("main = '\\u{1f408}'", "'\\u", 'string.quoted.single.nyanco');
  check('f Some(~) = print', 'Some', 'entity.name.type.nyanco');
  check('f Some(~) = print', '~', 'variable.language.stack.nyanco');
  for (const ref of ['_', '_1', '__2', '$', '$$1']) check('f = '+ref, ref, 'variable.language.stack.nyanco');
  check('f = my_name', 'my_name', 'variable.other.nyanco');
  check('loop @outer {break@outer}', '@outer', 'entity.name.label.nyanco');
  check('f = 1.25e-3', '1.25', 'constant.numeric.nyanco');
  check('r.x <- 1', '.x', 'variable.other.property.nyanco');
  for (const op of ['<-', '->', '??', '::', '.<<.', '.>>.', '.&.', '.|.', '..=', '&&', '||'])
    check('x '+op+' y', op, 'keyword.operator.nyanco');
  check('f = "value {1 + 2}"', '+', 'keyword.operator.nyanco');
  check('f = "value {1 + 2}"', '1', 'meta.embedded.inline.nyanco');
  check('f = "value {{x: 1}.x}"', '1', 'constant.numeric.nyanco');
  check('f = "value {\"nested\"}"', 'nested', 'string.quoted.double.nyanco');
  check('f = "\\{not interpolation\\}"', '\\{', 'constant.character.escape.nyanco');
  check('f = "\\{not interpolation\\}"', 'not', 'string.quoted.double.nyanco');
  const unfinished = grammar.tokenizeLine('f = "unfinished', textmate.INITIAL);
  const next = grammar.tokenizeLine('data example = Example', unfinished.ruleStack);
  assert.ok(next.tokens[0].scopes.includes('keyword.declaration.nyanco'));
  // Exercise every shipped example for invalid Oniguruma expressions / runaway rules.
  const examples = path.resolve(root, '../../examples');
  for (const name of fs.readdirSync(examples).filter(n => n.endsWith('.nyan'))) {
    let state = textmate.INITIAL;
    for (const line of fs.readFileSync(path.join(examples, name), 'utf8').split(/\r?\n/)) {
      const result = grammar.tokenizeLine(line, state, 1000);
      assert.ok(!result.stoppedEarly, `Tokenizer timed out: ${name}`);
      state = result.ruleStack;
    }
  }
  registry.dispose();
  console.log('Nyanco grammar: token scopes and all examples passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
