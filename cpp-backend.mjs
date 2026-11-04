import {readFileSync} from 'node:fs';
import {createTypedIR} from './typed-ir.mjs';
import {withStandardFunctions} from './builtin-functions.mjs';
import {withOption} from './builtin-option.mjs';
import {ioEffects} from './builtin-effects.mjs';
import {lookupInstance} from './class-relations.mjs';
import {vectorOwnership} from './ownership.mjs';
import {parseExpression} from './language.mjs';
import {checkExpression, formatType, missingOperands, StaticTypeError} from './types.mjs';
import {T, tuple, neverValues, StoppedEmission, items, effectParts, copyEnv, freshTypes} from './native-types.mjs';
import {transforms, streamTransforms, countTransform} from './iteration.mjs';
import {patternNames} from './type-syntax.mjs';

// Fixed-width octal escapes make generated source independent of the compiler's
// input encoding and preserve embedded zero bytes in Nyanco strings.
function string(value) {
  const bytes = Buffer.from(value, 'utf8');
  const escaped = Array.from(bytes, n => n >= 32 && n <= 126 && n !== 34 && n !== 92
    ? String.fromCharCode(n) : '\\' + n.toString(8).padStart(3, '0')).join('');
  return `std::string("${escaped}", ${bytes.length})`;
}
const loc = token => string(token ? `${token.file}:${token.line}:${token.col}` : '<entry>');
const arguments_ = count => Array.from({length: count}, (_, i) => `a${i}`);
const resultType = count => `Results<${count}>`;
const params = count => arguments_(count).map(name => `const Value& ${name}`);
const scalarTypes = new Map([['int','Int'], ['byte','Byte'], ['float','double'], ['bool','bool']]);
const cppType = type => {
  const resolved = type && T.prune(type);
  return resolved?.tag === 'atom' ? scalarTypes.get(resolved.name) || 'Value' : 'Value';
};
const nativeResult = types => {
  if (types.every(type => type === 'Value')) return resultType(types.length);
  return types.length === 1 ? types[0] : `std::tuple<${types.join(', ')}>`;
};
const values = inputs => `Values{${inputs.join(', ')}}`;
const take = (stack, count) => count ? stack.splice(-count) : [];
// Nested scopes handle their own bindings. Only statements executed in this
// environment can require a copy of its binding table.
const needsLocalEnv = nodes => nodes.some(node =>
  ['bind','update','local-function'].includes(node.kind) ||
  node.kind === 'capture' && node.slots.some(slot => slot.capturedName) ||
  node.kind === 'word' && node.ephemeral ||
  node.kind === 'application' && needsLocalEnv(node.body)
);
const patternKinds = {
  'word': 'word', 'literal': 'literal', 'constructor': 'constructor', 'list-pattern': 'vector',
  'push-pattern': 'push', 'record-pattern': 'record', 'tuple-pattern': 'tuple'
};
const bitwise = new Map([['.&.','&'], ['.|.','|'], ['xor','^']]);
const bitPositions = new Set(['.<<.','.>>.','testBit','setBit','clearBit']);
const binaryNames = new Set([
  '+', '-', '*', '/', '%', '^', '<', '<=', '>', '>=', '==', '/=', '&&', '||',
  ...bitwise.keys(), ...bitPositions, '++', '::', 'vpush', 'push', 'Push', 'concat', 'cons', '..', '..=', 'range'
]);
const canReuse = new Set(['++', '::', 'vpush', 'push', 'Push', 'concat']);

function literal(node, type = node.numericKind === 'float' ? 'float' : 'int') {
  const v = node.value;
  if (typeof v === 'string') return string(v);
  if (typeof v === 'boolean') return String(v);
  if (v?.kind === 'scalar') return `Char{${v.value.codePointAt(0)}}`;
  if (type === 'float') {
    const number = Object.is(v, -0) ? '-0.0' : String(v);
    return `static_cast<double>(${/[.e]/i.test(number) ? number : number + '.0'})`;
  }
  const n = BigInt(node.numberSource ?? v);
  if (type === 'byte') return `Byte{${n}}`;
  return `bits(UINT64_C(${BigInt.asUintN(64, n)}))`;
}
function pattern(node) {
  const kind = patternKinds[node.kind];
  if (!kind) throw new StaticTypeError(`Unsupported C++ pattern: ${node.kind}`, node);
  const name = ['word', 'constructor'].includes(node.kind) ? string(node.value) : '{}';
  const literals = node.kind === 'literal' ? values([literal(node)]) : '{}';
  const fields = (node.fields || []).map(pattern).join(', ');
  const keys = (node.keys || []).map(string).join(', ');
  return `Pattern{PatternKind::${kind}, ${name}, ${literals}, {${fields}}, {${keys}}, ${!!node.mutable}}`;
}
const patterns = nodes => `{${nodes.map(pattern).join(', ')}}`;
function unsupported(token, feature = token.value || token.kind) {
  throw new StaticTypeError(`Unsupported by the C++ backend: ${feature}`, token);
}

export function transpileCpp(program, {
  expression = 'main', entryNodes = null, showStack = false, optimizeVectors = true, onIR = null
} = {}) {
  const definitions = withStandardFunctions(withOption(Object.assign(new Map(program.definitions), {
    ...program.definitions, effects: ioEffects(program.definitions.effects)
  })));
  const entry = entryNodes || parseExpression(
    definitions.moduleTokens?.(expression, '<entry>') || expression, '<entry>', definitions.constructors
  );
  checkExpression(entry, definitions);
  const ir = createTypedIR(definitions, {ownership: optimizeVectors});
  const vectorReuse = optimizeVectors ? vectorOwnership(definitions, entry) : new WeakSet();
  const functions = new Map();
  const invocations = new Map();
  const helpers = new Map();
  const sites = [];
  const sitesByNode = new WeakMap();
  const representations = new Map();
  const scalarBindings = new Map();
  let next = 0;
  const id = prefix => `${prefix}${next++}`;
  const typedDispatch = [...definitions.methods.values()].some(m => m.dispatchIndex < 0 && !m.specialCast);
  const latent = effect => typedDispatch ? T.effectSnapshot(effect.effects) : undefined;
  const signatureKey = (input, output, effect) => formatType(T.quote(tuple(input), tuple(output), effect && latent(effect)));
  const representation = value => representations.get(value) || 'Value';
  function readAs(value, type) {
    const actual = representation(value);
    if (type === actual || type === 'Value') return value;
    if (actual !== 'Value') throw new Error(`C++ lowering cannot convert ${actual} to ${type}`);
    return `as<${type}>(${value})`;
  }
  function bindings(env) {
    if (!scalarBindings.has(env)) scalarBindings.set(env,new Map());
    return scalarBindings.get(env);
  }
  function cloneEnv(ctx, parent) {
    const env = id('env');
    ctx.add(`Env ${env} = ${parent};`);
    scalarBindings.set(env,new Map(bindings(parent)));
    return env;
  }
  function captureEnv(ctx, env) {
    const scalars = bindings(env);
    if (!scalars.size) return env;
    const snapshot = id('captured');
    ctx.add(`Env ${snapshot} = ${env};`);
    for (const [name,value] of scalars) ctx.add(`${snapshot}.bind(${string(name)}, ${value});`);
    return snapshot;
  }

  function context() {
    const lines = [];
    return {
      lines,
      add: (...text) => lines.push(...text),
      value(expression, type = 'Value') {
        const name = id('v');
        lines.push(`${type} ${name} = ${expression};`);
        if (type !== 'Value') representations.set(name,type);
        return name;
      },
      call(fn, inputs, outputCount) {
        const call = `${fn}(${inputs.join(', ')})`;
        if (!outputCount) { lines.push(call + ';'); return []; }
        const result = id('results');
        lines.push(`auto ${result} = ${call};`);
        return Array.from({length: outputCount}, (_, i) => this.value(`std::move(${result}[${i}])`));
      }
    };
  }
  function finish(ctx, output, types = output.map(() => 'Value')) {
    if (output.never) {
      ctx.add('fail("<generated>", "Non-returning computation returned");');
      return;
    }
    const returned = output.map((value,i) => readAs(value,types[i]));
    ctx.add(`return {${returned.join(', ')}};`);
  }
  function assign(ctx, targets, sources) {
    if (targets.length !== sources.length) throw new Error('C++ lowering produced inconsistent stack arity');
    if (!targets.length) return;
    const copies = targets.map((target,i) => {
      const type = representation(target);
      return ctx.value(readAs(sources[i],type),type);
    });
    targets.forEach((target, i) => ctx.add(`${target} = std::move(${copies[i]});`));
  }
  function bindPatterns(ctx, env, ps, inputs, types, mutable, at) {
    const remaining = [], boxed = [], checks = [];
    for (const [i,p] of ps.entries()) {
      for (const name of patternNames([p])) bindings(env).delete(name);
      const type = types[i];
      if (p.kind === 'word' && p.value === '_') continue;
      if (p.kind === 'word' && type !== 'Value' && !p.mutable && !mutable?.get(p.value) && env !== 'm.globals') {
        const value = ctx.value(readAs(inputs[i],type),type);
        bindings(env).set(p.value,value);
      } else if (p.kind === 'literal' && representation(inputs[i]) !== 'Value' &&
                 (typeof p.value === 'boolean' && type === 'bool' ||
                  typeof p.value === 'number' && ['Int','Byte','double'].includes(type) &&
                  (p.numericKind !== 'float' || type === 'double'))) {
        checks.push(`${inputs[i]} == ${literal(p)}`);
      } else {
        remaining.push(p);
        boxed.push(inputs[i]);
      }
    }
    const target = at ? id('matched') : env;
    if (remaining.length) {
      if (at) ctx.add(`Env ${target};`);
      checks.push(`matches(${patterns(remaining)}, ${values(boxed)}, ${target})`);
    }
    const check = checks.length ? checks.join(' && ') : null;
    if (!at) return check;
    if (check) ctx.add(`if (!(${check})) fail(${at}, "Assignment pattern did not match");`);
    for (const name of patternNames(remaining)) {
      ctx.add(`${env}.bind(${string(name)}, ${target}.read(${string(name)}), ${!!mutable.get(name)});`);
    }
    return null;
  }
  function branch(ctx, clause, inputs, env, trace, guardTrace = trace) {
    const count = clause.patterns.length;
    const patternValues = count ? inputs.slice(-count) : [];
    let state = count ? inputs.slice(0, -count) : [...inputs];
    ctx.add('{');
    const local = cloneEnv(ctx,env);
    const condition = bindPatterns(ctx,local,clause.patterns,patternValues,patternValues.map(representation));
    ctx.add(condition ? `if (${condition}) {` : '{');
    if (clause.guard) {
      const guardEnv = cloneEnv(ctx,local);
      state = emit(clause.guard, state, guardEnv, new Map(), guardTrace, ctx);
      if (state.never) {
        ctx.add('}', '}');
        return null;
      }
      ctx.add(`if (${readAs(state.pop(),'bool')}) {`);
    }
    const output = emit(clause.body, state, local, new Map(), trace, ctx);
    return {output, close: () => ctx.add(...(clause.guard ? ['}'] : []), '}', '}')};
  }
  function named(name, effect) {
    const {input, output} = effectParts(effect);
    const signature = signatureKey(input, output, effect);
    const key = name + ':' + signature;
    if (functions.has(key)) return functions.get(key);
    if (functions.size >= 1000) throw new Error('C++ function specialization limit exceeded');
    const fn = `fn${functions.size}`;
    const inputTypes = input.map(cppType), outputTypes = output.map(cppType);
    const args = inputTypes.map(type => {
      const arg = id('arg');
      if (type !== 'Value') representations.set(arg,type);
      return arg;
    });
    const parameters = args.map((arg,i) => `${inputTypes[i] === 'Value' ? 'const Value&' : inputTypes[i]} ${arg}`);
    const spec = {fn, inputTypes, outputTypes,
      header: `${nativeResult(outputTypes)} ${fn}(${['Machine& m', ...parameters].join(', ')})`};
    functions.set(key, spec);
    const ctx = context();
    for (const clause of definitions.get(name)) {
      const arity = clause.patterns.length;
      const env = copyEnv(ir.globals);
      const concrete = freshTypes(input, output, latent(effect));
      const ins = items(concrete.input), outs = items(concrete.output);
      env.locals = new Set();
      clause.patterns.forEach((p, i) => ir.pattern(p, ins[ins.length - arity + i], env));
      const base = arity ? ins.slice(0, -arity) : ins;
      const guard = clause.guard ? ir.analyze(clause.guard, tuple(base), new Map(env)) : null;
      const bodyInput = guard ? items(guard.output).slice(0, -1) : base;
      const analysis = ir.analyze(clause.body, tuple(bodyInput), env);
      T.unify(analysis.output, tuple(outs), clause.token);
      if (typedDispatch) T.specializeEffects(analysis.effects, concrete.effects, clause.token);
      const emitted = branch(ctx, clause, args, 'm.globals', analysis.trace, guard?.trace);
      if (emitted) { finish(ctx, emitted.output,outputTypes); emitted.close(); }
      ir.describe(analysis.trace, {kind:'function', name, signature, patterns:clause.patterns}, ins, outs);
      if (guard) ir.describe(guard.trace, {kind:'guard', name, signature});
    }
    ctx.add(`fail(${loc(definitions.get(name)[0].token)}, ${string('No matching pattern for ' + name)});`);
    spec.body = ctx.lines;
    return spec;
  }
  function callNamed(ctx, name, effect, stack) {
    const spec = named(name, effect);
    const args = take(stack,spec.inputTypes.length).map((value,i) => readAs(value,spec.inputTypes[i]));
    if (spec.outputTypes.every(type => type === 'Value')) {
      stack.push(...ctx.call(spec.fn,['m',...args],spec.outputTypes.length));
      return;
    }
    const call = `${spec.fn}(${['m',...args].join(', ')})`;
    if (spec.outputTypes.length === 1) stack.push(ctx.value(call,spec.outputTypes[0]));
    else {
      const result = id('results');
      ctx.add(`auto ${result} = ${call};`);
      spec.outputTypes.forEach((type,i) => stack.push(ctx.value(`std::get<${i}>(std::move(${result}))`,type)));
    }
  }
  function registerSite(node, env, body = node.body) {
    const key = [...env].map(([name, scheme]) =>
      name + '=' + (scheme.callable ? 'function:' : 'value:') + formatType(scheme.type)).join(';');
    if (!sitesByNode.has(node)) sitesByNode.set(node, new Map());
    const existing = sitesByNode.get(node);
    if (existing.has(key)) return existing.get(key);
    if (sites.length >= 500) throw new Error('C++ quotation specialization limit exceeded');
    const site = sites.length;
    sites.push({site, node, body, env: copyEnv(env)});
    existing.set(key, site);
    return site;
  }
  function invocation(effect) {
    const {input, output} = effectParts(effect);
    const key = signatureKey(input, output, effect);
    if (invocations.has(key)) return invocations.get(key);
    if (invocations.size >= 500) throw new Error('C++ quotation call specialization limit exceeded');
    const fn = `invoke${invocations.size}`;
    const spec = {
      fn, input, output, key, effects:latent(effect), cases:new Map(),
      header:`${resultType(output.length)} ${fn}(${['Machine& m','const Value& value','const std::string& at',...params(input.length)].join(', ')})`
    };
    invocations.set(key, spec);
    return spec;
  }
  function callQuote(ctx, q, effect, stack, at) {
    const spec = invocation(effect);
    stack.push(...ctx.call(spec.fn, ['m', q, at, ...take(stack, spec.input.length)], spec.output.length));
    if (T.isBottom(T.prune(effect).output)) {
      ctx.add(`fail(${at}, "Non-returning quotation returned");`);
      return neverValues();
    }
    return stack;
  }
  function dynamicResults(ctx, expression, count) {
    const name = id('result');
    ctx.add(`auto ${name} = ${expression};`);
    return Array.from({length: count}, (_, i) => ctx.value(`std::move(${name}.at(${i}))`));
  }
  function customMethod(token, effect) {
    const method = definitions.methods.get(token.value);
    if (!method || !effect) return null;
    const cls = definitions.classes.get(method.className);
    const dispatch = effect.dispatchTypes || (effect.dispatchType ? [effect.dispatchType] : []);
    if (!dispatch.length) return null;
    const heads = dispatch.map(t => {
      t = T.prune(t);
      if (t.numericLiterals) { T.unify(t, {tag:'atom', name:'int'}, token); t = T.prune(t); }
      return t;
    });
    return lookupInstance(cls, heads)?.implementations.get(token.value) || null;
  }
  function callBit(ctx, token, a, b, leftType, rightType) {
    const op = token.value;
    const integer = leftType === 'Int' || leftType === 'Byte';
    const bitwiseOperator = bitwise.get(op);
    const native = bitwiseOperator
      ? (integer || leftType === 'bool') && leftType === rightType
      : integer && rightType === 'Int';
    if (!native) return ctx.value(`bitOp(m, ${string(op)}, ${a}, ${b}, ${loc(token)})`);

    const left = readAs(a,leftType), right = readAs(b,rightType);
    if (leftType === 'bool') {
      const operator = bitwiseOperator === '^' ? '!=' : bitwiseOperator;
      return ctx.value(`${left} ${operator} ${right}`,'bool');
    }
    const unsignedLeft = `static_cast<UInt>(${left})`;
    const result = value => ctx.value(leftType === 'Byte' ? `static_cast<Byte>(${value})` : `bits(${value})`,leftType);
    if (bitwiseOperator) return result(`${unsignedLeft} ${bitwiseOperator} static_cast<UInt>(${right})`);

    const pos = ctx.value(`bitPosition(m, ${right}, ${leftType === 'Byte' ? 8 : 64}, ${loc(token)})`,'unsigned');
    if (op === '.<<.') return result(`${unsignedLeft} << ${pos}`);
    if (op === '.>>.') {
      // C++20 signed right shift is arithmetic. Byte shifts use unsigned bits.
      return leftType === 'Int' ? ctx.value(`${left} >> ${pos}`,'Int') : result(`${unsignedLeft} >> ${pos}`);
    }
    const mask = `(UInt{1} << ${pos})`;
    if (op === 'testBit') return ctx.value(`(${unsignedLeft} & ${mask}) != 0`,'bool');
    return result(op === 'setBit' ? `${unsignedLeft} | ${mask}` : `${unsignedLeft} & ~${mask}`);
  }
  function callBinary(ctx, token, a, b, effect, reuse = false) {
    const target = customMethod(token, effect);
    if (target) {
      const stack = [a, b];
      callNamed(ctx, target, effect, stack);
      return stack[0];
    }
    const inputs = effect && items(effect.input);
    const type = inputs?.at(-2);
    const scalar = cppType(type), rightType = cppType(inputs?.at(-1)), op = token.value;
    if (bitwise.has(op) || bitPositions.has(op)) return callBit(ctx,token,a,b,scalar,rightType);
    if (scalar !== 'Value' && scalar === rightType) {
      const left = readAs(a,scalar), right = readAs(b,scalar);
      if (['==','/=','<','<=','>','>='].includes(op))
        return ctx.value(`${left} ${op === '/=' ? '!=' : op} ${right}`,'bool');
      if (scalar === 'bool' && ['&&','||'].includes(op))
        return ctx.value(`${left} ${op} ${right}`,'bool');
      if (scalar !== 'bool' && ['+','-','*','/','%','^'].includes(op)) {
        if (scalar === 'Int' && ['+','-','*'].includes(op))
          return ctx.value(`bits(static_cast<UInt>(${left}) ${op} static_cast<UInt>(${right}))`,scalar);
        const operation = {Int:'intOp',Byte:'byteOp',double:'floatOp'}[scalar];
        return ctx.value(`${operation}(${string(op)}, ${left}, ${right}, ${loc(token)})`,scalar);
      }
    }
    if (type && ['==','/=','<','<=','>','>='].includes(token.value)) {
      const eq = token.value === '==' || token.value === '/=';
      const operation = valueOperation(eq ? 'eq' : 'ord',type,token);
      const call = `${operation}(m,${a},${b})`;
      return ctx.value(eq ? (token.value === '/=' ? '!' : '') + call : `${call} ${token.value} 0`,'bool');
    }
    return ctx.value(`binary(${string(token.value)}, ${a}, ${b}, ${loc(token)}, ${reuse})`);
  }
  function callIndex(ctx, token, effect, args, optional = false) {
    const methodToken = {...token, value:args.length === 2 ? 'at' : 'setAt'};
    const target = customMethod(methodToken, effect);
    if (!target) {
      if (optional) return ctx.value(`option(findIndex(${args.join(', ')}))`);
      return ctx.value(`${args.length === 2 ? 'atIndex' : 'setIndex'}(m, ${args.join(', ')}, ${loc(token)})`);
    }
    if (!optional) {
      callNamed(ctx, target, effect, args);
      return args[0];
    }
    const inner = context();
    callNamed(inner, target, effect, args);
    return dynamicResults(ctx, `handle(m, [&](Machine& m) -> Values {
${inner.lines.join('\n')}
return {option(${args[0]})};
}, {{"exn", [](const Values&, Ptr<Continuation>) -> Values {return {option()};}}})`, 1)[0];
  }
  function shown(ctx, value, type, token, rawStrings = false) {
    type = T.prune(type);
    if (rawStrings && type.tag === 'atom' && type.name === 'string') return `as<std::string>(${value})`;
    const shown = ctx.value(`${valueOperation('show',type,token)}(m,${value})`);
    return `as<std::string>(${shown})`;
  }

  function valueOperation(kind,type,token) {
    type = T.prune(type);
    const key = kind + ':' + formatType(type,{defaultNumbers:false});
    if (helpers.has(key)) return helpers.get(key).fn;
    const fn = `valueOp${helpers.size}`, pair = kind === 'eq' || kind === 'ord';
    const result = {show:'std::string',hash:'std::uint32_t',eq:'bool',ord:'int'}[kind];
    const header = `${result} ${fn}(Machine& m,const Value& a${pair ? ',const Value& b' : ''})`;
    const ctx = context();
    helpers.set(key,{fn,header,body:ctx.lines});
    const implementation = lookupInstance(definitions.classes.get(kind),[type])?.implementations;
    const method = kind === 'eq' ? '==' : kind === 'ord' ? '<' : kind;
    const invoke = word => {
      const effect = T.instantiate(ir.functions.get(implementation.get(word)));
      T.unify(effect.input,T.stack(T.EMPTY,...(pair ? [type,type] : [type])),token);
      const args = pair ? ['a','b'] : ['a'];
      callNamed(ctx,implementation.get(word),effect,args);
      return args[0];
    };
    if (implementation?.has(method)) {
      const value = invoke(method);
      if (kind === 'ord') {
        ctx.add(`if (truth(${value})) return -1;`);
        ctx.add(`return truth(${invoke('>')}) ? 1 : 0;`);
      } else ctx.add(`return ${kind === 'eq' ? `truth(${value})` : kind === 'show'
        ? `as<std::string>(${value})` : `hashValue(${value})`};`);
      return fn;
    }
    const sub = (t,a,b) => `${valueOperation(kind,t,token)}(m,${a}${pair ? ','+b : ''})`;
    const check = call => kind === 'eq' ? `if (!${call}) return false;` : `if (auto rank = ${call}) return rank;`;
    const fallback = {eq:'equal(a,b)',ord:'compare(a,b)',hash:'hashValue(a)',show:'show(a)'}[kind];
    if (type.tag === 'list') {
      ctx.add('const auto& xs = as<Ptr<Vector>>(a)->values;');
      if (pair) {
        ctx.add('const auto& ys = as<Ptr<Vector>>(b)->values;');
        if (kind === 'eq') ctx.add('if (xs.size() != ys.size()) return false;');
        ctx.add(`for (std::size_t i=0; i<std::min(xs.size(),ys.size()); ++i) ${check(sub(type.item,'xs[i]','ys[i]'))}`,
          kind === 'eq' ? 'return true;' : 'return order(xs.size(),ys.size());');
      } else if (kind === 'hash') {
        ctx.add('auto hash = hashText("vector");',`for (const auto& x : xs) hash=hashMix(hash,${sub(type.item,'x')});`,'return hash;');
      } else ctx.add('std::vector<std::string> parts;',`for (const auto& x : xs) parts.push_back(${sub(type.item,'x')});`,'return "["+join(parts,", ")+"]";');
    } else if (type.tag === 'tuple' || type.tag === 'record') {
      const fields = [];
      let open;
      if (type.tag === 'tuple') {
        type.items.forEach(t => fields.push([fields.length,t]));
        let tail = T.prune(type.tail);
        while (tail.tag === 'tuple-tail') {
          tail.items.forEach(t => fields.push([fields.length,t]));
          tail = T.prune(tail.tail);
        }
        open = tail.tag !== 'tuple-end';
      } else {
        let row = T.prune(type.row);
        while (row.tag === 'record-row') {
          fields.push(...row.fields);
          row = T.prune(row.tail);
        }
        fields.sort(([a],[b])=>a<b?-1:a>b?1:0);
        open = row.tag !== 'record-empty';
      }
      if (open) { ctx.add(`return ${fallback};`); return fn; }
      const record = type.tag === 'record';
      const access = (variable,key) => record ? `field(${variable},${string(key)})` : `tupleAt(${variable},${key})`;
      if (pair) {
        for (const [key,t] of fields) ctx.add(check(sub(t,access('a',key),access('b',key))));
        ctx.add(`return ${kind === 'eq' ? 'true' : '0'};`);
      } else if (kind === 'hash') {
        ctx.add(`auto hash = hashText("${type.tag}");`);
        for (const [key,t] of fields) {
          if (record) ctx.add(`hash=hashMix(hash,hashText(${string(key)}));`);
          ctx.add(`hash=hashMix(hash,${sub(t,access('a',key))});`);
        }
        ctx.add('return hash;');
      } else {
        const parts = fields.map(([key,t]) => (record ? string(key+': ')+'+' : '') + sub(t,access('a',key)));
        ctx.add(record && !parts.length ? 'return "{:}";'
          : `return "${record ? '{' : '#('}"+join({${parts.join(',')}}, "${record ? ', ' : ' '}")+"${record ? '}' : ')'}";`);
      }
    } else if (type.tag === 'adt' && (['option','result'].includes(type.name) || kind === 'show') && type.name !== 'dict') {
      const constructors = [...definitions.constructors.values()].filter(c => c.typeName === type.name);
      if (constructors.length) {
        ctx.add('const auto& x = *as<Ptr<Adt>>(a);');
        if (pair) ctx.add('const auto& y = *as<Ptr<Adt>>(b);',`if (x.name != y.name) return ${kind === 'ord' ? 'compare(a,b)' : 'false'};`);
        for (const c of constructors) {
          const params = new Map(c.parameters.map((p,i)=>[p,type.args[i]]));
          const fields = c.fields.map(t=>T.syntaxType(t,params));
          ctx.add(`if (x.name == ${string(c.name)}) {`);
          const parts = fields.map((t,i)=>sub(t,`x.fields[${i}]`,`y.fields[${i}]`));
          if (pair) {
            for (const call of parts) ctx.add(check(call));
            ctx.add(kind === 'eq' ? 'return true;' : 'return 0;');
          } else if (kind === 'hash') {
            ctx.add('auto hash = hashText(x.type+":"+x.name);');
            for (const call of parts) ctx.add(`hash=hashMix(hash,${call});`);
            ctx.add('return hash;');
          } else ctx.add(parts.length ? `return "("+x.display+" "+join({${parts.join(',')}}, " ")+")";` : 'return x.display;');
          ctx.add('}');
        }
      }
      ctx.add(`return ${fallback};`);
    } else ctx.add(`return ${fallback};`);
    return fn;
  }

  function emit(nodes, stack, env, holes, trace, ctx) {
    holes.references ??= new Map();
    for (const instruction of ir.instructions(nodes, trace, {local:env !== 'm.globals'})) {
      const n = instruction.source;
      const info = instruction.typing;
      if (!info) break;
      const at = loc(n);
      const reuse = optimizeVectors && (instruction.ownership?.mode === 'move' || vectorReuse.has(n));
      const child = (body, initial = [], bindings = holes, into = ctx) => {
        const scope = needsLocalEnv(body) ? cloneEnv(into,env) : env;
        const result = emit(body, initial, scope, bindings, trace, into);
        if (result.never) throw new StoppedEmission();
        return result;
      };
      const get = name => `${env}.read(${string(name)})`;
      try {
        switch (n.kind) {
          case 'capture': {
            const removed = new Set();
            for (const slot of n.slots) {
              const value = stack.at(-1-slot.index);
              holes.references.set(slot, value);
              if (slot.capturedName) ctx.add(`${env}.bind(${string(slot.capturedName)}, ${value});`);
              if (!slot.peek) removed.add(slot.index);
            }
            if (removed.size) stack = stack.filter((_, i) => !removed.has(stack.length-1-i));
            break;
          }
          case 'reference':
            stack.push(holes.references.get(n));
            break;
          case 'missing':
            if (holes.has(n)) stack.push(holes.get(n));
            break;
          case 'literal': {
            const type = T.prune(info.output).item;
            const numeric = typeof n.value === 'number' && n.numericKind !== 'float'
              ? T.integerLiteralInfo(definitions, n, type) : null;
            if (numeric?.conversion) {
              const value = ctx.value(literal(n, 'int'),'Int');
              if (numeric.conversion.target === 'fromInt')
                stack.push(ctx.value(`cast(m, ${value}, ${string(numeric.conversion.destination)}, ${at})`));
              else {
                const args = [value];
                callNamed(ctx, numeric.conversion.target, numeric.effect, args);
                stack.push(...args);
              }
            } else {
              const numericType = numeric?.type || T.numericName(type);
              const cpp = scalarTypes.get(numericType) || cppType(type);
              stack.push(ctx.value(literal(n,numericType || undefined),cpp));
            }
            break;
          }
          case 'application':
            stack = emit(info.application, stack, env, holes, trace, ctx);
            break;
          case 'scope':
            stack = child(n.body, stack);
            break;
          case 'list':
          case 'tuple':
            stack.push(ctx.value(`${n.kind === 'list' ? 'vector' : 'tuple'}(${values(child(n.body))})`));
            break;
          case 'interpolation': {
            const args = take(stack, n.fields.filter(f => f.empty).length);
            let pos = 0;
            const parts = [string(n.chunks[0])];
            n.fields.forEach((field, i) => {
              const value = field.empty ? args[pos++] : child(field.body)[0];
              parts.push(shown(ctx, value, info.formatTypes[i], n, true), string(n.chunks[i+1]));
            });
            stack.push(ctx.value(parts.join(' + ')));
            break;
          }
          case 'record': {
            const bound = bindHoles(n, stack, holes);
            const fields = n.fields.map(f => `{${string(f.name)}, ${child(f.body, [], bound)[0]}}`);
            stack.push(ctx.value(`record({${fields.join(', ')}})`));
            break;
          }
          case 'dict': {
            const dict = makeDict(ctx, T.prune(T.prune(info.output).item).args[0], n);
            for (let i=0; i<n.fields.length; i+=2) {
              const key = child(n.fields[i].body)[0];
              const value = child(n.fields[i+1].body)[0];
              ctx.add(`${dict}->set(${key}, ${value});`);
            }
            stack.push(ctx.value(dict));
            break;
          }
          case 'field':
            stack.push(ctx.value(`field(${stack.pop()}, ${string(n.name)})`));
            break;
          case 'tuple-index':
            stack.push(ctx.value(`tupleAt(${stack.pop()}, ${n.index})`));
            break;
          case 'list-index': {
            const source = stack.pop(), index = child(n.body)[0];
            stack.push(callIndex(ctx, n, info.indexGet, [source, index], n.optional));
            break;
          }
          case 'path-update': {
            const source = stack.pop();
            const args = n.fields.slice(0,-1).map(f => child(f.body)[0]);
            const path = n.path.map((p, i) => {
              const methods = info.indexPaths?.[i];
              const makeAccessor = (name, effect, inputs) => {
                const target = customMethod({...n,value:name},effect);
                if (!target) return '{}';
                const accessor = context(), state = [...inputs];
                callNamed(accessor,target,effect,state);
                return `[](Machine& m,${inputs.map(name=>`const Value& ${name}`).join(',')}) -> Value {
  ${accessor.lines.join('\n')}
  return ${state[0]};
}`;
              };
              const get = makeAccessor('at',methods?.get,['source','index']);
              const set = makeAccessor('setAt',methods?.set,['source','index','replacement']);
              const index = p.kind === 'tuple-index' ? `Int{${p.index}}` : args[p.argument] || 'Value{}';
              return `{${string(p.kind)}, ${string(p.name || '')}, ${index}, ${!!p.optional}, ${get}, ${set}}`;
            });
            const inner = context();
            const local = cloneEnv(inner,env);
            const result = emit(n.fields.at(-1).body, n.updating ? ['old'] : [], local,
              n.updating ? new Map() : holes, trace, inner);
            inner.add(result.never ? `fail(${at}, "Non-returning update returned");` : `return ${result[0]};`);
            const replace = `[&](Value old) -> Value {\n${inner.lines.join('\n')}\n}`;
            stack.push(ctx.value(`updatePath(m, ${source}, {${path.join(', ')}}, 0, ${replace}, ${!!n.defaulting}, ${!!n.updating}, ${reuse}, ${at})`));
            break;
          }
          case 'quote': {
            const site = registerSite(n, info.env);
            const captured = captureEnv(ctx,env);
            stack.push(ctx.value(`std::make_shared<Quote>(Quote{${site}, ${captured}, {}})`));
            break;
          }
          case 'local-function': {
            const site = registerSite(n, info.localEnv);
            const name = string(n.name);
            const captured = captureEnv(ctx,env);
            ctx.add(`${env}.bind(${name}, std::make_shared<Quote>(Quote{${site}, ${captured}, ${name}}));`);
            bindings(env).delete(n.name);
            break;
          }
          case 'bind': {
            const inputs = take(stack, n.patterns.length);
            const inputTypes = items(info.input);
            const types = inputTypes.slice(inputTypes.length-inputs.length).map(cppType);
            bindPatterns(ctx,env,n.patterns,inputs,types,new Map(n.names.map((name,i)=>[name,n.mutable[i]])),at);
            break;
          }
          case 'update': {
            const names = n.names || [n.name];
            const output = child(n.body, n.fromStack ? take(stack, names.length) : []);
            names.forEach((name, i) => ctx.add(`${env}.update(${string(name)}, ${output[i]});`));
            break;
          }
          case 'case': {
            const outputs = items(info.output).map(cppType).map(type => ctx.value(type+'{}',type));
            const matched = id('matched');
            ctx.add(`bool ${matched} = false;`);
            for (const clause of n.branches) {
              ctx.add(`if (!${matched}) {`);
              const result = branch(ctx, clause, stack, env, trace);
              if (result) {
                if (!result.output.never) assign(ctx, outputs, result.output);
                ctx.add(`${matched} = true;`);
                result.close();
              }
              ctx.add('}');
            }
            ctx.add(`if (!${matched}) fail(${at}, "No matching case branch");`);
            stack = outputs;
            break;
          }
          case 'binary':
          case 'comparison-chain':
            stack.push(emitOperator(n, info, stack, holes, ctx, child));
            break;
          case 'label': {
            const scope = cloneEnv(ctx,env);
            ctx.add(`${scope}.bind(${string(n.key)}, std::make_shared<Label>());`);
            bindings(scope).delete(n.key);
            stack = emit(n.body, stack, scope, holes, trace, ctx);
            break;
          }
          case 'mask':
          case 'borrow': {
            const inner = context(), local = cloneEnv(inner,env);
            if (n.kind === 'borrow') {
              const borrow = id('borrow');
              inner.add(`BorrowScope ${borrow}(${env}.cell(${string(n.owner)}));`,
                `${local}.bind(${string(n.reference)}, ${borrow}.ref);`);
              bindings(local).delete(n.reference);
            }
            const output = emit(n.body, [...stack], local, holes, trace, inner);
            inner.add(output.never ? `fail(${at}, "Non-returning block returned");` : `return ${values(output)};`);
            const lambda = `[&](${n.kind === 'mask' ? 'Machine& m' : ''}) -> Values {\n${inner.lines.join('\n')}\n}`;
            const target = n.target ? `labelTarget(${get(n.target)}, ${at})` : 'nullptr';
            const call = n.kind === 'mask' ? `mask(m, ${lambda}, ${string(n.operation)}, ${target})` : `(${lambda})()`;
            stack = dynamicResults(ctx, call, items(info.output).length);
            break;
          }
          case 'word':
            stack = word(n, info, stack, ctx, env, reuse);
            break;
          default:
            unsupported(n);
        }
        if (stack.never) return stack;
        if (T.isBottom(info.output)) {
          ctx.add(`fail(${at}, "Non-returning computation returned");`);
          return neverValues();
        }
      } catch (error) {
        if (error instanceof StoppedEmission) return neverValues();
        throw error;
      }
    }
    return stack;
  }

  function bindHoles(node, stack, holes) {
    const missing = missingOperands([node]).filter(hole => !holes.has(hole));
    const inputs = take(stack, missing.length);
    const bound = new Map(holes);
    bound.references = holes.references;
    missing.forEach((hole, i) => bound.set(hole, inputs[i]));
    return bound;
  }
  function emitOperator(n, info, stack, holes, ctx, child) {
    const bound = bindHoles(n, stack, holes);
    if (n.kind === 'comparison-chain') {
      let left = child(n.operands[0], [], bound)[0];
      const result = ctx.value('true','bool');
      for (let i=0; i<n.operators.length; i++) {
        ctx.add(`if (${result}) {`);
        try {
          const right = child(n.operands[i+1], [], bound)[0];
          const compared = callBinary(ctx,n.operators[i],left,right,info.operatorEffects[i]);
          ctx.add(`${result} = ${readAs(compared,'bool')};`);
          left = right;
        } catch (error) {
          if (!(error instanceof StoppedEmission)) throw error;
          for (let j=0; j<=i; j++) ctx.add('}');
          return result;
        }
      }
      for (const op of n.operators) ctx.add('}');
      return result;
    }
    const a = child(n.left, [], bound)[0];
    if (n.value !== '&&' && n.value !== '||') {
      const b = child(n.right, [], bound)[0];
      return callBinary(ctx, n, a, b, info.operatorEffects[0]);
    }
    const type = cppType(T.prune(info.output).item);
    const result = ctx.value(readAs(a,type),type);
    let condition = a;
    if (n.value === '||') {
      const target = customMethod({...n,value:'hasValue'}, info.orElsePredicate);
      if (target) {
        const args = [a];
        callNamed(ctx, target, info.orElsePredicate, args);
        condition = args[0];
      }
    }
    ctx.add(`if (${n.value === '||' ? '!' : ''}${readAs(condition,'bool')}) {`);
    try {
      const b = child(n.right, [], bound)[0];
      const selected = n.value === '||' ? callBinary(ctx, n, a, b, info.operatorEffects[0]) : b;
      ctx.add(`${result} = ${readAs(selected,type)};`);
    } catch (error) { if (!(error instanceof StoppedEmission)) throw error; }
    ctx.add('}');
    return result;
  }

  function makeDict(ctx, type, token) {
    const hash = valueOperation('hash',type,token);
    const dict = id('dict');
    ctx.add(`auto ${dict} = std::make_shared<Dict>();`);
    ctx.add(`${dict}->hash = [&globals=m.globals](const Value& key) { Machine m{globals,{}}; return ${hash}(m,key); };`,
      `${dict}->equal = equal;`);
    return dict;
  }
  function walker(source, type, token) {
    type = T.prune(type);
    const custom = lookupInstance(definitions.classes.get('streem'), [type])?.implementations.get('each');
    if (!custom) return `[${source}](Machine& m, const Visit& visit) {walk(m, ${source}, visit);}`;
    const item = T.iterableItem(type);
    const callback = T.quote(T.stack(T.EMPTY,item), T.EMPTY);
    const spec = named(custom, T.quote(T.stack(T.EMPTY,type,callback), T.EMPTY));
    return `[${source}](Machine& m, const Visit& visit) {
${spec.fn}(m, ${source}, std::make_shared<NativeVisitor>(NativeVisitor{visit}));
}`;
  }
  function callback(q, effect, at) {
    const inner = context();
    const result = callQuote(inner, q, effect, ['item'], at);
    if (!result.never) inner.add(`return ${result[0]};`);
    return `[${q}](Machine& m, Value item) -> Value {\n${inner.lines.join('\n')}\n}`;
  }
  function replaceOnBreak(ctx, stack, breakResult) {
    if (!stack.length) return;
    ctx.add(`if (${breakResult}) {`);
    assign(ctx, stack, stack.map((_, i) => `${breakResult}->at(${i})`));
    ctx.add('}');
  }

  function word(n, info, stack, ctx, env, reuse) {
    const name = n.value, at = loc(n), get = key => `${env}.read(${string(key)})`;
    const label = n.handlerLabel ? `as<Ptr<Label>>(${get(n.handlerLabel)})` : 'Ptr<Label>{}';
    const pop = () => stack.pop();
    const push = expression => stack.push(ctx.value(expression));
    const inputs = () => items(info.input);
    const outCount = () => items(info.output).length;
    const call = (q, effect, state = stack, into = ctx) => callQuote(into, q, effect, state, at);
    if (info.env.has(name)) {
      const callable = info.env.get(name).callable;
      const type = callable ? 'Value' : cppType(T.prune(info.output).item);
      const value = bindings(env).get(name) || ctx.value(readAs(get(name),type),type);
      if (n.ephemeral) {
        bindings(env).delete(name);
        ctx.add(`${env}.erase(${string(name)});`);
      }
      if (callable) return call(value, info.effect);
      stack.push(value);
      return stack;
    }
    const method = definitions.methods.get(name);
    const custom = method && !method.specialCast && !method.specialEach && customMethod(n, info.effect);
    if (custom) {
      callNamed(ctx, custom, info.effect, stack);
      return stack;
    }
    if (definitions.has(name)) {
      callNamed(ctx, name, info.effect, stack);
      return stack;
    }
    const constructor = definitions.constructors.get(name);
    if (constructor) {
      const args = take(stack, constructor.fields.length);
      push(`adt(${string(constructor.typeName)}, ${string(name)}, ${string(constructor.token.sourceName || name)}, ${values(args)})`);
      return stack;
    }
    const operation = definitions.effects.get(name);
    if (operation) {
      const count = operation.syntax.input[0]?.tag === 'stack-row' ? stack.length : operation.inputCount;
      const args = take(stack, count);
      const target = n.target ? `labelTarget(${get(n.target)}, ${at})` : 'nullptr';
      const results = operation.syntax.output[0]?.tag === 'stack-row' ? items(info.effect.output).length : operation.outputCount;
      stack.push(...dynamicResults(ctx, `m.perform(Event{${string(name)}, ${at}, ${values(args)}, ${operation.never}, ${target}})`, results));
      return stack;
    }
    if (binaryNames.has(name)) {
      const [a,b] = take(stack,2);
      stack.push(callBinary(ctx,n,a,b,info.effect,reuse && canReuse.has(name)));
    } else if (method?.specialCast) {
      const conversion = T.castInfo(definitions,n,info.effect);
      if (conversion.target !== name) callNamed(ctx, conversion.target, info.effect, stack);
      else push(`cast(m, ${pop()}, ${string(conversion.destination)}, ${at})`);
    } else if (name === 'not') {
      stack.push(ctx.value(`!${readAs(pop(),'bool')}`,'bool'));
    } else if (['head','tail','length','chars','bytes'].includes(name)) {
      push(`unary(${string(name)}, ${pop()}, ${at})`);
    } else if (name === 'hash') {
      const operation = valueOperation('hash',inputs().at(-1),n);
      push(`static_cast<Int>(${operation}(m,${pop()}))`);
    } else if (name === 'at' || name === 'setAt') {
      stack.push(callIndex(ctx,n,info.effect,take(stack,name === 'at' ? 2 : 3)));
    } else if (['parseInt','parseFloat','toNum'].includes(name)) {
      push(`parseNumber(m, ${pop()}, ${name === 'parseInt'}, ${name !== 'toNum'}, ${at})`);
    } else if (name === 'nop') {
      return stack;
    } else if (name === 'dup') stack.push(stack.at(-1));
    else if (name === 'drop') pop();
    else if (name === 'over') stack.push(stack.at(-2));
    else if (name === 'swap') { const [a,b] = take(stack,2); stack.push(b,a); }
    else if (name === 'rot') { const [a,b,c] = take(stack,3); stack.push(b,c,a); }
    else if (name === 'show') push(shown(ctx,pop(),inputs().at(-1),n));
    else if (name === 'print') ctx.add(`m.perform(Event{"put", ${at}, {raw(${pop()})}});`);
    else if (name === 'readRef') push(`readBorrow(${pop()}, ${at})`);
    else if (name === 'writeRef') {
      const [ref,value] = take(stack,2);
      ctx.add(`writeBorrow(${ref}, ${value}, ${at});`);
    } else if (name === 'call') return call(pop(), inputs().at(-1));
    else if (name === 'dip') {
      const [saved,q] = take(stack,2);
      const result = call(q,inputs().at(-1));
      if (!result.never) result.push(saved);
      return result;
    } else if (name === 'if' || name === 'when') {
      const [condition, yes, no] = take(stack,name === 'if' ? 3 : 2);
      const types = inputs(), outputs = items(info.output).map(cppType).map(type => ctx.value(type+'{}',type));
      ctx.add(`if (${readAs(condition,'bool')}) {`);
      const first = call(yes,types.at(no ? -2 : -1),[...stack]);
      if (!first.never) assign(ctx,outputs,first);
      ctx.add('} else {');
      const second = no ? call(no,types.at(-1),[...stack]) : stack;
      if (!second.never) assign(ctx,outputs,second);
      ctx.add('}');
      return outputs;
    } else if (name === 'while') {
      const [cond,body] = take(stack,2), types = inputs();
      const state = stack.map(v => ctx.value(v));
      const count = outCount();
      // The condition can change the state type, while cancellation can return
      // the last state before the first condition completed.
      const outputs = Array.from({length:count}, (_,i) => ctx.value(state.length === count ? state[i] : 'Value{}'));
      const result = id('breakResult');
      ctx.add(`auto ${result} = loop(m, [&](Machine& m) {`, 'while (true) {');
      const condition = call(cond,types.at(-2),[...state]);
      if (!condition.never) {
        const flag = condition.pop();
        assign(ctx,outputs,condition);
        ctx.add(`if (!${readAs(flag,'bool')}) break;`);
        const next = call(body,types.at(-1),condition);
        if (!next.never) assign(ctx,state,next);
      }
      ctx.add('}', `}, ${label});`);
      replaceOnBreak(ctx,outputs,result);
      return outputs;
    } else if (['each','fold','vmap','vfilter'].includes(name)) {
      return iterate(n, info, stack, ctx, label);
    } else if (name === 'compose') {
      const [a,b] = take(stack,2), types = inputs();
      const portable = t => {
        const {input,output} = effectParts(t), row = T.row();
        return T.mono(T.quote(T.stack(row,...input),T.stack(row,...output)));
      };
      const captured = new Map([['__a',portable(types.at(-2))],['__b',portable(types.at(-1))]]);
      const body = ['__a','call','__b','call'].map(value => ({...n,kind:'word',value}));
      const site = registerSite(n,captured,body), e = id('env');
      ctx.add(`Env ${e};`, `${e}.bind("__a", ${a});`, `${e}.bind("__b", ${b});`);
      push(`std::make_shared<Quote>(Quote{${site}, ${e}, {}})`);
    } else if (name === 'handle') {
      const [q,handlers] = take(stack,2);
      const inner = context(), body = call(q,info.bodyType,[],inner);
      inner.add(body.never ? `fail(${at}, "Non-returning body returned");` : `return ${values(body)};`);
      const entries = [];
      for (const [effect, type] of info.handlers) {
        const handler = context();
        const ref = handler.value(`field(${handlers}, ${string(type.handlerField || effect)})`);
        const count = effectParts(type).input.length - 1;
        const inputs = Array.from({length:count}, (_, i) => `args.at(${i})`);
        const result = call(ref,type,[...inputs,'Value{k}'],handler);
        handler.add(result.never ? `fail(${at}, "Non-returning handler returned");` : `return ${values(result)};`);
        entries.push(`{${string(effect)}, [&](const Values& args, Ptr<Continuation> k) -> Values {
${handler.lines.join('\n')}
}}`);
      }
      const action = `handle(m, [&](Machine& m) -> Values {\n${inner.lines.join('\n')}\n}, {${entries.join(', ')}}, ${label})`;
      stack.push(...dynamicResults(ctx,action,outCount()-stack.length));
    } else if (name === 'resume') {
      const k = pop();
      const parts = effectParts(inputs().at(-1));
      const args = take(stack,parts.input.length);
      stack.push(...dynamicResults(ctx,`resume(${k}, ${values(args)}, ${at})`,parts.output.length));
    } else if (name === 'fromYield') {
      const q = pop(), inner = context();
      call(q,info.bodyType,[],inner);
      push(`fromYield(${label}, [${q}](Machine& m) {\n${inner.lines.join('\n')}\n})`);
    } else {
      return collectionWord(n,info,stack,ctx,label,reuse);
    }
    return stack;
  }

  function iterate(n, info, stack, ctx, label) {
    const type = items(info.input), name = n.value, at = loc(n);
    const q = stack.pop(), acc = name === 'fold' ? stack.pop() : null, source = stack.pop();
    const state = stack.map(v => ctx.value(v));
    const accumulator = acc ? ctx.value(acc) : null;
    const collecting = name === 'vmap' || name === 'vfilter';
    const collected = id('collected'), broken = id('breakResult'), walk = id('walk');
    if (collecting) ctx.add(`Values ${collected};`);
    ctx.add(`auto ${walk} = ${walker(source,type.at(acc ? -3 : -2),n)};`,
      `auto ${broken} = loop(m, [&](Machine& m) {`, `${walk}(m, [&](Value item) {`);
    const output = callQuote(ctx,q,type.at(-1),[...state,...(acc ? [accumulator] : []),'item'],at);
    if (!output.never) {
      if (name === 'vmap') ctx.add(`${collected}.push_back(${output.pop()});`);
      if (name === 'vfilter') ctx.add(`if (truth(${output.pop()})) ${collected}.push_back(item);`);
      if (acc) ctx.add(`${accumulator} = ${output.pop()};`);
      assign(ctx,state,output);
    }
    ctx.add('});', `}, ${label});`);
    if (acc) state.push(accumulator);
    if (collecting) state.push(ctx.value(`vector(std::move(${collected}))`));
    replaceOnBreak(ctx,state,broken);
    return state;
  }

  function collectionWord(n, info, stack, ctx, label, reuse) {
    const name = n.value, at = loc(n), types = items(info.input);
    const push = expression => stack.push(ctx.value(expression));
    if (transforms.has(name)) {
      const mode = transforms.get(name);
      const arg = mode === 'flatten' ? null : stack.pop(), source = stack.pop();
      const type = types.at(arg ? -2 : -1), walk = walker(source,type,n);
      const count = countTransform(mode) ? `countValue(m, ${arg}, ${string(name)}, ${at})` : '0';
      const fn = arg && !countTransform(mode) ? callback(arg,types.at(-1),at) : 'MapItem{}';
      const nestedType = mode === 'flatten' ? T.iterableItem(type)
        : mode === 'flatMap' ? items(T.prune(types.at(-1)).output).at(-1) : null;
      const nested = nestedType ? `[](Machine& m, Value item, const Visit& visit) {
auto walkItem = ${walker('item',nestedType,n)};
walkItem(m,visit);
}` : '{}';
      const lazy = streamTransforms.has(name);
      const stream = ctx.value(`transform(${walk}, ${string(mode)}, ${count}, ${fn}, ${lazy ? label : 'Ptr<Label>{}'}, ${!lazy}, ${nested})`);
      if (lazy) stack.push(stream);
      else return collect(ctx, stack, walker(stream,T.prune(info.output).item,n), label);
      return stack;
    }
    if (name === 'split') {
      const [source,separator] = take(stack,2);
      push(`split(${source}, ${separator})`);
      return stack;
    }
    if (name === 'values') {
      const source = stack.pop();
      push(`stream([${source}](Machine&, const Visit& visit) {
for (const auto& pair : as<Ptr<Dict>>(${source})->entries()) visit(pair.second);
})`);
      return stack;
    }
    if (name === 'max' || name === 'min') {
      const [a,b] = take(stack,2);
      const less = callBinary(ctx,{...n,value:'<'},b,a,info.comparison);
      push(`truth(${less}) ? ${name === 'max' ? a : b} : ${name === 'max' ? b : a}`);
      return stack;
    }
    if (name === 'zip' || name === 'vzip') {
      const [left,right] = take(stack,2);
      const lazy = name === 'zip';
      const combined = ctx.value(`zip(${walker(left,types.at(-2),n)}, ${walker(right,types.at(-1),n)}, ${lazy ? label : 'Ptr<Label>{}'})`);
      if (lazy) stack.push(combined);
      else return collect(ctx,stack,`[${combined}](Machine& m,const Visit& visit){ walk(m,${combined},visit); }`,label);
      return stack;
    }
    if (['windows','chunks','chunkBy'].includes(name)) {
      const [source,arg] = take(stack,2), keyed = name === 'chunkBy';
      const walk = walker(source,types.at(-2),n);
      const count = keyed ? '0' : `countValue(m, ${arg}, ${string(name)}, ${at}, true)`;
      const key = keyed ? callback(arg,types.at(-1),at) : 'MapItem{}';
      const inner = context();
      const less = keyed && info.comparison ? callBinary(inner,{...n,value:'=='},'a','b',info.comparison) : null;
      const eq = less ? `[](Machine& m,const Value& a,const Value& b) { ${inner.lines.join(' ')} return truth(${less}); }` : '{}';
      push(`partition(${walk}, ${string(name)}, ${count}, ${key}, ${eq}, ${label})`);
      return stack;
    }
    if (['permutations','combinations','combinationsWithReplacement','powerset','cartesianProduct'].includes(name)) {
      const arg = name === 'powerset' ? null : stack.pop(), source = stack.pop();
      const right = name === 'cartesianProduct' ? walker(arg,types.at(-1),n) : 'Walk{}';
      const count = arg && name !== 'cartesianProduct' ? `countValue(m,${arg},${string(name)},${at})` : '0';
      push(`combinatorics(${walker(source,types.at(arg ? -2 : -1),n)}, ${right}, ${count}, ${string(name)})`);
      return stack;
    }
    if (['deque','heap','qpush','qpushFront','qpop','qpopBack','qpeek','qpeekBack','qlength','qisEmpty',
         'hpush','hpop','hpeek','hlength','hisEmpty'].includes(name)) {
      if (name === 'deque' || name === 'heap') {
        push(`std::make_shared<Collection>(Collection{${string(name)}, {}})`);
        return stack;
      }
      const pushing = ['qpush','qpushFront','hpush'].includes(name);
      const item = pushing ? stack.pop() : 'Value{}', source = stack.pop();
      const cmp = context();
      let compare = '{}';
      if (name === 'hpush' || name === 'hpop') {
        const type = pushing ? types.at(-1) : T.prune(types.at(-1)).args[0];
        const effect = comparisonEffect('<',type);
        const less = callBinary(cmp,{...n,value:'<'},'a','b',effect);
        compare = `[&](const Value& a, const Value& b) { ${cmp.lines.join(' ')} return truth(${less}); }`;
      }
      stack.push(...ctx.call('collectionOp',[string(name),source,item,compare,String(reuse)],2)
        .slice(0,['qpop','qpopBack','hpop'].includes(name) ? 2 : 1));
      return stack;
    }
    if (['toVector','join','nth','reverse','sort','sortBy','maxi','mini','maxiBy','miniBy',
         'all','any','toDict','counts','groupBy'].includes(name)) {
      return consume(n, info, stack, ctx, label);
    }
    unsupported(n);
  }
  function comparisonEffect(op, type) {
    const effect = T.instantiate(ir.functions.get(op));
    T.unify(effect.input,T.stack(T.EMPTY,type,type));
    return effect;
  }
  function collect(ctx, stack, walk, label) {
    const result = id('items'), broken = id('breakResult');
    const state = stack.map(v => ctx.value(v));
    ctx.add(`Values ${result};`, `auto ${broken} = loop(m,[&](Machine& m) {
(${walk})(m,[&](Value item){${result}.push_back(std::move(item));});
}, ${label});`);
    state.push(ctx.value(`vector(std::move(${result}))`));
    replaceOnBreak(ctx,state,broken);
    return state;
  }
  function consume(n, info, stack, ctx, label) {
    const name = n.value, types = items(info.input), at = loc(n);
    const withArg = ['join','nth','sortBy','maxiBy','miniBy','all','any','groupBy'].includes(name);
    const arg = withArg ? stack.pop() : null, source = stack.pop();
    const walk = walker(source,types.at(arg ? -2 : -1),n);
    if (name === 'toVector') return collect(ctx,stack,walk,label);
    const dict = ['toDict','counts','groupBy'].includes(name)
      ? makeDict(ctx,T.prune(T.prune(info.output).item).args[0],n) : null;
    const key = arg && !['join','nth'].includes(name) ? callback(arg,types.at(-1),at) : '{}';
    const cmp = context();
    const order = info.comparison && !['groupBy','all','any'].includes(name);
    const less = order ? callBinary(cmp,{...n,value:'<'},'a','b',info.comparison) : null;
    const compare = less ? `[](Machine& m, const Value& a,const Value& b) { ${cmp.lines.join(' ')} return truth(${less}); }` : '{}';
    const result = id('consumed');
    const state = stack.map(v => ctx.value(v));
    ctx.add(`auto ${result} = consume(m,${walk},${string(name)},${arg || 'Value{}'},${key},${compare},${dict || '{}'},${label});`);
    state.push(ctx.value(`std::move(${result}.value)`));
    replaceOnBreak(ctx,state,`${result}.broken`);
    return state;
  }

  const initializers = definitions.initializers || [];
  const initialEnv = new Map();
  initialEnv.locals = new Set();
  const initial = ir.analyze(initializers,T.EMPTY,initialEnv), main = context();
  emit(initializers,[],'m.globals',new Map(),initial.trace,main);
  ir.describe(initial.trace,{kind:'initialization'});
  const entryAnalysis = ir.analyze(entry,T.EMPTY,new Map(ir.globals));
  const output = emit(entry,[],'m.globals',new Map(),entryAnalysis.trace,main);
  ir.describe(entryAnalysis.trace,{kind:'entry',expression});
  if (showStack && !output.never) main.add(`std::cout << show(vector(${values(output)})) << '\\n';`);

  // Quotations are monomorphized at reachable invocation signatures, just like
  // named functions. A quotation value contains its site and lexical bindings.
  let changed = true;
  while (changed) {
    changed = false;
    for (const spec of invocations.values()) for (const {site,node,body,env} of sites) {
      if (spec.cases.has(site)) continue;
      spec.cases.set(site,null);
      changed = true;
      const signature = freshTypes(spec.input,spec.output,spec.effects);
      let analysis;
      try {
        analysis = ir.analyze(body,signature.input,copyEnv(env),node.blockLabel);
        if (T.isBottom(signature.output) && !T.isBottom(analysis.output)) continue;
        T.checkNeverPromises(analysis.output,signature.output,node);
        T.unify(analysis.output,signature.output,node);
        if (typedDispatch) {
          T.specializeEffects(analysis.effects,signature.effects,node);
          ir.validate(body,analysis.trace);
        }
      } catch (error) {
        if (error instanceof StaticTypeError) continue;
        throw error;
      }
      const ctx = context();
      scalarBindings.delete('local');
      const results = emit(body,arguments_(spec.input.length),'local',new Map(),analysis.trace,ctx);
      ir.describe(analysis.trace,{kind:'quotation',site,signature:spec.key},spec.input,spec.output);
      if (node.blockLabel) {
        const lines = [...ctx.lines];
        ctx.lines.length = 0;
        const action = `labelBlock(m,[&](Machine& m,Ptr<Label> label) -> Values {
local.bind(${string(node.blockLabel)},label);
${lines.join('\n')}
${results.never ? 'fail(at,"Non-returning block returned");' : `return ${values(results)};`}
})`;
        finish(ctx,dynamicResults(ctx,action,spec.output.length));
      } else finish(ctx,results);
      spec.cases.set(site,ctx.lines.join('\n'));
    }
  }
  const quotationFunctions = [...invocations.values()].map(spec => {
    const visitor = spec.input.length === 1 && spec.output.length === 0
      ? 'if (is<Ptr<NativeVisitor>>(value)) { as<Ptr<NativeVisitor>>(value)->visit(a0); return {}; }' : '';
    const cases = [...spec.cases].filter(([,code])=>code).map(([site,code])=>`case ${site}: {\n${code}\n}`).join('\n');
    return `${spec.header} {
${visitor}
const auto& q = as<Ptr<Quote>>(value);
Env local = q->env;
if (!q->self.empty()) local.bind(q->self,value);
switch (q->site) {
${cases}
}
fail(at, "Unsupported quotation specialization");
}`;
  });
  const declarations = [...functions.values(), ...invocations.values(), ...helpers.values()].map(spec => spec.header + ';');
  const bodies = [...functions.values(), ...helpers.values()].map(spec => `${spec.header} {\n${spec.body.join('\n')}\n}`);
  const runtime = readFileSync(new URL('./cpp-runtime.hpp.txt',import.meta.url),'utf8');
  if (onIR) onIR(ir.serialize());
  return `${runtime}
namespace nyanco {
${declarations.join('\n')}

${bodies.join('\n\n')}

${quotationFunctions.join('\n\n')}
}

int main() {
    using namespace nyanco;
    std::ios::sync_with_stdio(false);
    std::cin.tie(nullptr);
    try {
        Env globals;
        Machine m{globals, {}};
${main.lines.map(line=>'        '+line).join('\n')}
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "Error: " << error.what() << '\\n';
        return 1;
    }
}
`;
}
