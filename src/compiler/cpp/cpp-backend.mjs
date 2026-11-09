import {createTypedIR} from '../typed-ir.mjs';
import {emitCppRuntime} from './cpp-runtime.mjs';
import {withStandardFunctions} from '../../runtime/builtin-functions.mjs';
import {withOption} from '../../runtime/builtin-option.mjs';
import {ioEffects, worklistOperations} from '../../runtime/builtin-effects.mjs';
import {lookupInstance} from '../../types/class-relations.mjs';
import {collectionQueryType,collectionOperationTarget} from '../../types/operator-classes.mjs';
import {cppLifetimes} from './cpp-lifetimes.mjs';
import {parseExpression} from '../../frontend/language.mjs';
import {checkExpression, formatType, missingOperands, StaticTypeError} from '../../types/types.mjs';
import {T, tuple, neverValues, StoppedEmission, items, effectParts, copyEnv, freshTypes} from '../native-types.mjs';
import {transforms, streamTransforms, countTransform, predicateTransform} from '../../runtime/iteration.mjs';
import {patternNames} from '../../types/type-syntax.mjs';
import {hashText} from '../../runtime/hash-map.mjs';
import {lowerCppCoroutines} from './cpp-coroutines.mjs';
import {lowerCppRc} from './cpp-rc.mjs';

// Fixed-width octal escapes make generated source independent of the compiler's
// input encoding and preserve embedded zero bytes in Nyanco strings.
function stringLiteral(value) {
  const bytes = Buffer.from(value, 'utf8');
  const escaped = Array.from(bytes, n => n >= 32 && n <= 126 && n !== 34 && n !== 92
    ? String.fromCharCode(n) : '\\' + n.toString(8).padStart(3, '0')).join('');
  return `"${escaped}", ${bytes.length}`;
}
const string = value => `std::string(${stringLiteral(value)})`;
const arguments_ = count => Array.from({length: count}, (_, i) => `a${i}`);
const resultType = count => `Results<${count}>`;
const params = count => arguments_(count).map(name => `Value ${name}`);
const scalarTypes = new Map([['int','Int'], ['byte','Byte'], ['float','double'], ['bool','bool']]);
const adtCollectionFields = new Map([
  ['dict','Ptr<DictBase>'], ['set','Ptr<HashSetBase>'], ['deque','Ptr<Queue>'], ['heap','Ptr<Collection>']
]);
const scalarCppType = type => {
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
  'word': 'word', 'literal': 'literal', 'constructor': 'constructor', 'list-pattern': 'vector', 'or-pattern': 'alternative',
  'push-pattern': 'push', 'concat-pattern': 'concatenate', 'record-pattern': 'record', 'tuple-pattern': 'tuple'
};
const nativeAdtPattern = p => p.kind==='constructor' &&
  p.fields.every(field => ['word','literal'].includes(field.kind) || nativeAdtPattern(field));
const bitwise = new Map([['.&.','&'], ['.|.','|'], ['xor','^']]);
const bitPositions = new Set(['.<<.','.>>.','testBit','setBit','clearBit']);
const arithmetic = new Map([['+','add'], ['-','subtract'], ['*','multiply'],
  ['/','divide'], ['%','remainder'], ['^','power']]);
const bitCodes = new Map([['.&.','bitAnd'], ['.|.','bitOr'], ['xor','bitXor'],
  ['.<<.','shiftLeft'], ['.>>.','shiftRight']]);
const castType = new Map([['int','Int'], ['byte','Byte'], ['float','double'], ['char','Char'], ['string','std::string']]);
const binaryNames = new Set([
  '+', '-', '*', '/', '%', '^', '<', '<=', '>', '>=', '==', '/=', '&&', '||',
  ...bitwise.keys(), ...bitPositions, '++', '::', 'vpush', 'push', 'Push', 'concat', 'cons', '..', '..=', 'range'
]);
const canReuse = new Set(['++', '::', 'vpush', 'push', 'Push', 'concat']);
const nativeWorklistOperations = new Map(Object.entries(worklistOperations)
  .map(([name,word]) => [word,name[0].toUpperCase()+name.slice(1)]));

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
function pattern(node, constructors) {
  if (node.kind === 'concat-pattern' && node.stringParts) {
    const {prefix,suffix} = node.stringParts;
    const middle = node.rest < 0 ? '' : pattern(node.fields[node.rest],constructors);
    return `Pattern{PatternKind::concatenateString, {}, ${values([string(prefix),string(suffix)])}, {${middle}}, {}}`;
  }
  const kind = patternKinds[node.kind];
  if (!kind) throw new StaticTypeError(`Unsupported C++ pattern: ${node.kind}`, node);
  const name = node.kind === 'word' ? string(node.value) : '{}';
  const literals = node.kind === 'literal' ? values([literal(node)]) : '{}';
  const fields = (node.fields || []).map(field => pattern(field,constructors)).join(', ');
  const keys = (node.keys || []).map(string).join(', ');
  const tag = node.kind === 'constructor' ? `, ${constructors.get(node.value).cpp}::tag` : node.kind==='concat-pattern'?`, {}, ${node.rest}`:'';
  return `Pattern{PatternKind::${kind}, ${name}, ${literals}, {${fields}}, {${keys}}, ${!!node.mutable}${tag}}`;
}
function adtLayout(definitions) {
  const families = new Map(), constructors = new Map();
  let next = 0, nextLayout = 0;
  function add(type, name, display, arity, source = null) {
    if (!families.has(type)) families.set(type,{id:families.size,members:[],layouts:new Map()});
    const family = families.get(type);
    const member = {family, name, display, arity, source, cpp:`AdtCtor${next++}`};
    family.members.push(member);
    return member;
  }
  for (const [name,ctor] of definitions.constructors) {
    constructors.set(name,add(ctor.typeName,name,ctor.token.sourceName || name,ctor.fields.length,ctor));
  }
  const runtimeOption = (name, arity) => {
    const member = constructors.get(name);
    return member && member.family === families.get('option') && member.arity === arity
      ? member : add('option',name,name,arity);
  };
  const none = runtimeOption('None',0), some = runtimeOption('Some',1);
  const fragments = [];
  for (const [type,family] of families) {
    // Keep the existing structural order for standard options and results.
    const first = type === 'option' ? 'None' : type === 'result' ? 'Ok' : null;
    family.members.sort((a,b) => a.name === b.name ? 0 : a.name === first ? -1 :
      b.name === first ? 1 : a.name < b.name ? -1 : 1);
    const declarations = family.members.map((c,index) => `struct ${c.cpp} {
    static constexpr AdtTag tag{${family.id}, ${index}};
    static constexpr AdtInfo info{std::string_view(${stringLiteral(c.display)}), UINT32_C(${hashText(type+':'+c.name)})};
};`);
    fragments.push({symbols:family.members.map(c=>c.cpp),text:declarations.join('\n')});
  }
  function layout(member, type, representation = () => 'Value') {
    const family = member.family;
    const instance = type && T.prune(T.aliasRepresentation(type));
    const fieldTypes = family.members.map(ctor => {
      if (!ctor.source || instance?.tag !== 'adt' || instance.name !== ctor.source.typeName)
        return Array(ctor.arity).fill(null);
      const bindings = new Map(ctor.source.parameters.map((name,i) => [name,instance.args[i]]));
      return ctor.source.fields.map(field => T.syntaxType(field,bindings));
    });
    const fields = fieldTypes.map(types=>types.map(type=>type ? representation(type) : 'Value'));
    const key = fields.map(types=>types.join(',')).join('|');
    let current = family.layouts.get(key);
    if (!current) {
      const index = nextLayout++, cpp = `AdtFamily${index}`;
      const alternatives = family.members.map((ctor,i) => [ctor,{cpp:`${ctor.cpp}_${index}`,types:fields[i]}]);
      const declarations = alternatives.map(([ctor,alt]) =>
        `using ${alt.cpp} = AdtFields<${[ctor.cpp,...alt.types].join(', ')}>;`);
      declarations.push(`using ${cpp} = AdtValue<${family.id}, ${alternatives.map(([,alt])=>alt.cpp).join(', ')}>;`);
      fragments.push({symbols:[cpp,...alternatives.map(([,alt])=>alt.cpp)],text:declarations.join('\n')});
      current = {cpp,alternatives:new Map(alternatives)};
      family.layouts.set(key,current);
    }
    const alternative = current.alternatives.get(member);
    return {family:current.cpp, ...alternative, fields:fieldTypes[family.members.indexOf(member)]};
  }
  const make = (layout, args) => `makeAdt<${layout.family}>(${layout.cpp}{{${args.join(', ')}}})`;
  const optionAlternative = ctor => `AdtFields<${[ctor.cpp,...(ctor===some?['T']:Array(ctor.arity).fill('Value'))].join(', ')}>`;
  fragments.push({symbols:['typedOption'],text:`template <typename T>
Adt typedOption(std::optional<T> value) {
    using Family = AdtValue<${none.family.id}, ${none.family.members.map(optionAlternative).join(', ')}>;
    return value ? makeAdt<Family>(${optionAlternative(some)}{{std::move(*value)}})
                 : makeAdt<Family>(${optionAlternative(none)}{{}});
}`});
  fragments.push({symbols:['option'],text:`inline Value option(std::optional<Value> value) {
    return typedOption(std::move(value));
}`});
  return {constructors, families, layout, make, fragments};
}
function unsupported(token, feature = token.value || token.kind) {
  throw new StaticTypeError(`Unsupported by the C++ backend: ${feature}`, token);
}

export function transpileCpp(program, {
  expression = 'main', entryNodes = null, showStack = false, optimizeVectors = true, onIR = null, noSourcePaths = false, batchIO = false, nativeVectors = true, effectCoroutines = true, nativeHashTries = true, referenceCounting = 'shared', nativeLocals = true
} = {}) {
  const locText = token => token ? `${noSourcePaths ? '' : token.file + ':'}${token.line}:${token.col}` : '<entry>';
  const loc = token => string(locText(token));
  const locView = token => `std::string_view(${stringLiteral(locText(token))})`;
  const definitions = withStandardFunctions(withOption(Object.assign(new Map(program.definitions), {
    ...program.definitions, effects: ioEffects(program.definitions.effects)
  })));
  const entry = entryNodes || parseExpression(
    definitions.moduleTokens?.(expression, '<entry>') || expression, '<entry>', definitions.constructors
  );
  checkExpression(entry, definitions);
  const adts = adtLayout(definitions);
  const cppType = type => {
    const resolved = type && T.prune(T.aliasRepresentation(type));
    return resolved?.tag==='adt' && adts.families.has(resolved.name) ? 'Adt' : scalarCppType(resolved);
  };
  const patterns = nodes => `{${nodes.map(node=>pattern(node,adts.constructors)).join(', ')}}`;
  const ir = createTypedIR(definitions, {ownership: optimizeVectors});
  const vectorScalar = type => {
    if (!nativeVectors || !optimizeVectors || !type) return null;
    const container = T.prune(type);
    if (container.tag !== 'list') return null;
    const item = T.prune(container.item), native = cppType(item);
    return ['Int','Byte','double'].includes(native) ? native : item.numericLiterals ? 'Int' : null;
  };
  const localType = type => nativeLocals && nativeVectors && type && T.prune(type).tag==='list' ? 'Ptr<VectorBase>' : cppType(type);
  function adtFieldType(type) {
    const resolved = T.prune(T.aliasRepresentation(type));
    if (resolved.numericLiterals) return 'Int';
    if (resolved.tag === 'atom') {
      if (resolved.name === 'char') return 'Char';
      if (resolved.name === 'string') return 'std::string';
      if (resolved.name === 'range') return 'Range';
    }
    if (resolved.tag === 'list') return 'Ptr<VectorBase>';
    if (resolved.tag === 'tuple') return 'Ptr<Tuple>';
    if (resolved.tag === 'record') return 'Ptr<Record>';
    if (resolved.tag === 'stream') return 'Ptr<Stream>';
    if (resolved.tag === 'adt' && adtCollectionFields.has(resolved.name)) return adtCollectionFields.get(resolved.name);
    return cppType(resolved);
  }
  function streamRepresentation(type) {
    const resolved = T.prune(type);
    if (resolved.tag === 'atom' && resolved.name === 'string') return 'std::string';
    if (resolved.tag === 'atom' && resolved.name === 'char') return 'Char';
    return resolved.numericLiterals ? 'Int' : localType(resolved);
  }
  function typedIterable(type) {
    type = T.prune(type);
    if (!nativeLocals || !optimizeVectors || lookupInstance(definitions.classes.get('streem'),[type])) return null;
    if (type.name === 'range') return 'Int';
    return ['list','stream'].includes(type.tag) && streamRepresentation(type.item) !== 'Value'
      ? streamRepresentation(type.item) : null;
  }
  function nativePairTypes(type) {
    type = T.prune(type);
    if (type.tag !== 'tuple' || type.items.length !== 2 || T.prune(type.tail).tag !== 'tuple-end') return null;
    const fields = type.items.map(localType);
    return fields.includes('Value') ? null : fields;
  }
  const managed = type => type==='Value' || type==='Adt' || type.startsWith('Ptr<');
  const vectorFactory = (type,data) => `${vectorScalar(type) ? 'scalarVector<'+vectorScalar(type)+'>' : 'vector'}(${data})`;
  const lifetimePlans = new WeakMap();
  const functions = new Map();
  const invocations = new Map();
  const helpers = new Map();
  const sites = [];
  const sitesByNode = new WeakMap();
  const materializedSites = new Set();
  const representations = new Map();
  const scalarBindings = new Map();
  const cellBindings = new Map();
  const knownQuotes = new Map();
  const knownSplits = new Map();
  const knownByteStreams = new Map();
  const knownChunks = new Map();
  const pairLiterals = new Map();
  let inlineDepth = 0;
  function quoteValue(site, env, self = '{}') {
    materializedSites.add(site);
    return `std::make_shared<Quote>(Quote{${site}, ${env}, ${self}})`;
  }
  function materializeQuote(value,ctx) {
    const known = knownQuotes.get(value);
    if (!known?.deferred) return;
    known.deferred = false;
    const captured = known.directEnv ? captureEnv(ctx,known.env,known.names) : known.env;
    ctx.add(`Value ${value} = ${quoteValue(known.site,captured)};`);
  }
  let next = 0;
  const id = prefix => `${prefix}${next++}`;
  const typedDispatch = [...definitions.methods.values()].some(m => m.dispatchIndex < 0 && !m.specialCast);
  const latent = effect => typedDispatch ? T.effectSnapshot(effect.effects) : undefined;
  const signatureKey = (input, output, effect) => formatType(T.quote(tuple(input), tuple(output), effect && latent(effect)));
  const representation = value => representations.get(value) || representations.get(/^std::move\((\w+)\)$/.exec(value)?.[1]) || 'Value';
  function singleUseValue(producer,ctx,source,stack) {
    if(producer?.ctx!==ctx || stack.includes(source) || ctx.splitAliases?.(source))return false;
    const reference=new RegExp('\\b'+source+'\\b');
    return !ctx.lines.slice(producer.line+1).some(line=>reference.test(line));
  }
  function readAs(value, type) {
    const actual = representation(value);
    if (type === actual || type === 'Value') return value;
    if (actual !== 'Value') throw new Error(`C++ lowering cannot convert ${actual} to ${type}`);
    const moved=/^std::move\((\w+)\)$/.exec(value);
    if(moved)return `takeAs<${type}>(${moved[1]})`;
    return `as<${type}>(${value})`;
  }
  function bindings(env) {
    if (!scalarBindings.has(env)) scalarBindings.set(env,new Map());
    return scalarBindings.get(env);
  }
  function cells(env) {
    if (!cellBindings.has(env)) cellBindings.set(env,new Map());
    return cellBindings.get(env);
  }
  function readBinding(env,name,take = false) {
    const cell = cells(env).get(name);
    if (cell) return take ? `takeLocal(${cell.ref})` : `${cell.ref}->value`;
    const value = bindings(env).get(name);
    if (value) return take ? `std::move(${value})` : value;
    return `${env}.${take ? 'take' : 'read'}(${string(name)})`;
  }
  const cellBinding = (env,name) => cells(env).get(name)?.ref || `${env}.cell(${string(name)})`;
  function writeBinding(ctx,env,name,value) {
    const cell = cells(env).get(name);
    ctx.add(cell ? `${cell.ref}->value = ${readAs(value,cell.type)};` : `${env}.update(${string(name)}, ${value});`);
  }
  function cloneEnv(ctx, parent) {
    const env = id('env');
    ctx.add(`Env ${env} = ${parent};`);
    scalarBindings.set(env,new Map(bindings(parent)));
    cellBindings.set(env,new Map(cells(parent)));
    return env;
  }
  function captureEnv(ctx, env, names) {
    const scalars = bindings(env);
    const shared = cells(env);
    const snapshot = id('captured');
    const dynamic = names.filter(name=>!scalars.has(name)&&!shared.has(name));
    ctx.add(`Env ${snapshot} = ${env}.select({${dynamic.map(string).join(', ')}});`);
    for (const name of names) if (scalars.has(name)) {
      const value = scalars.get(name), type = representation(value);
      if (nativeLocals && type !== 'Value') {
        ctx.add(`${snapshot}.bindCell(${string(name)}, std::make_shared<NativeCell<${type}>>(${value}, false));`);
      } else ctx.add(`${snapshot}.bind(${string(name)}, ${value});`);
    }
    for (const name of names) if (shared.has(name)) ctx.add(`${snapshot}.bindCell(${string(name)}, ${shared.get(name).ref});`);
    return snapshot;
  }
  function captureLayout(env, names) {
    return nativeLocals ? names.flatMap(name => {
      const cell = cells(env).get(name);
      if (cell) return [{name,type:cell.type,mutable:true}];
      const type = representation(bindings(env).get(name));
      return type === 'Value' ? [] : [{name,type,mutable:false}];
    }) : [];
  }

  function context() {
    const lines = [];
    return {
      lines,
      move: value => value,
      pinned: new Set(),
      add: (...text) => lines.push(...text),
      value(expression, type = 'Value') {
        const name = id('v');
        lines.push(`${type} ${name} = ${expression};`);
        if (type !== 'Value') representations.set(name,type);
        return name;
      },
      call(fn, inputs, outputCount) {
        const call = `${fn}(${inputs.map((value,i) => this.move(value,inputs.filter((_,j) => i !== j))).join(', ')})`;
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
    const returned = output.map((value,i) => {
      const result = readAs(value,types[i]);
      return optimizeVectors && managed(types[i]) && !output.some((other,j) => i !== j && other === value)
        ? `std::move(${result})` : result;
    });
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
  function bindAdtPattern(ctx,env,p,input,type,mutable,checks,bind,prepare = null) {
    const ctor=adts.constructors.get(p.value),layout=adts.layout(ctor,type,adtFieldType);
    let ptr;
    if (prepare) {
      ptr=ctx.value('nullptr','const Adt*');
      checks.push(`(${ptr} = adtPointer((${prepare}, ${input}))) && ${ptr}->tag() == ${ctor.cpp}::tag`);
    } else {
      ptr=ctx.value(`adtPointer(${input})`,'const Adt*');
      checks.push(`${ptr} && ${ptr}->tag() == ${ctor.cpp}::tag`);
    }
    p.fields.forEach((field,index)=>{
      const native=layout.types[index];
      const access=`adtField<${layout.family},${layout.cpp},${index}>(*${ptr})`;
      if (field.kind==='constructor') {
        const nested=ctx.value(`${native}{}`,native);
        bindAdtPattern(ctx,env,field,nested,layout.fields[index],mutable,checks,bind,`${nested} = ${access}`);
      } else if (field.kind==='literal') {
        if (native==='Char') checks.push(`${access}.code == ${literal(field)}.code`);
        else if (['Int','Byte','double','bool','std::string'].includes(native)) checks.push(`${access} == ${literal(field)}`);
        else checks.push(`match(${pattern(field,adts.constructors)},${access},${env})`);
      } else if (field.value!=='_') {
        bind.push(()=>{
          const value=ctx.value(access,native);
          if (field.mutable||mutable?.get(field.value)) {
            const ref=ctx.value(`std::make_shared<NativeCell<${native}>>(std::move(${value}))`,`Ptr<NativeCell<${native}>>`);
            cells(env).set(field.value,{ref,type:native});
          } else bindings(env).set(field.value,value);
        });
      }
    });
  }
  function bindPatterns(ctx, env, ps, inputs, types, mutable, at, actualTypes = [], postMatch = null) {
    const remaining = [], boxed = [], checks = [], matchedLocals = [];
    const preserveInputs=nativeLocals&&ps.some(nativeAdtPattern);
    const consumeInput=i=>preserveInputs?inputs[i]:ctx.move(inputs[i],inputs.filter((_,j)=>i!==j));
    for (const [i,p] of ps.entries()) {
      for (const name of patternNames([p])) {bindings(env).delete(name);cells(env).delete(name);}
      const element = actualTypes[i] && T.prune(actualTypes[i]);
      const type = nativeLocals && p.kind==='word' && element ? localType(element) : types[i];
      if(nativeLocals && nativeAdtPattern(p) && (at||postMatch)){
        bindAdtPattern(ctx,env,p,inputs[i],element,mutable,checks,matchedLocals);
        continue;
      }
      const pair = ctx.nativePairs?.get(inputs[i]);
      if (pair && p.kind==='tuple-pattern' && p.fields.length===2 &&
          p.fields.every(field=>field.kind==='word' && !field.mutable && !mutable?.get(field.value))) {
        p.fields.forEach((field,j)=>{
          if(field.value!=='_')bindings(env).set(field.value,ctx.value(pair[j],representation(pair[j])));
        });
        continue;
      }
      if(at&&p.kind==='tuple-pattern'&&element?.tag==='tuple'&&p.fields.length===element.items.length&&
          p.fields.every((field,j)=>field.kind==='word'&&!field.mutable&&!mutable?.get(field.value)&&cppType(element.items[j])!=='Value')){
        ctx.add(`if(as<Ptr<Tuple>>(${inputs[i]})->values.size()!=${p.fields.length})fail(${at},"Assignment pattern did not match");`);
        p.fields.forEach((field,j)=>{if(field.value!=='_'){const native=cppType(element.items[j]);bindings(env).set(field.value,ctx.value(`as<${native}>(as<Ptr<Tuple>>(${inputs[i]})->values[${j}])`,native));}});continue;
      }
      const scalar = element?.tag === 'list' ? cppType(element.item) : 'Value';
      if (at && p.kind === 'list-pattern' && scalar !== 'Value' &&
          p.fields.every(field => field.kind === 'word' && !field.mutable && !mutable?.get(field.value))) {
        ctx.add(`if (as<Ptr<VectorBase>>(${inputs[i]})->size() != ${p.fields.length}) fail(${at}, "Assignment pattern did not match");`);
        const native = vectorScalar(actualTypes[i]);
        const data = native ? ctx.value(`scalarData<${native}>(${inputs[i]})`,'auto') : null;
        p.fields.forEach((field,j) => {
          if (field.value !== '_') bindings(env).set(field.value,ctx.value(native ? `${data}->scalars()[${j}]` : `as<${scalar}>(as<Ptr<VectorBase>>(${inputs[i]})->items()[${j}])`,scalar));
        });
        if (data) ctx.add(`${data}.reset();`);
        continue;
      }
      if (p.kind === 'word' && p.value === '_') continue;
      if (nativeLocals && p.kind === 'word' && (p.mutable || mutable?.get(p.value)) && env !== 'm.globals') {
        const cell = ctx.value(`std::make_shared<NativeCell<${type}>>(${readAs(consumeInput(i),type)})`,`Ptr<NativeCell<${type}>>`);
        cells(env).set(p.value,{ref:cell,type});
      } else if (p.kind === 'word' && (nativeLocals || type !== 'Value') && !p.mutable && !mutable?.get(p.value) && env !== 'm.globals') {
        const value = ctx.value(managed(type) ? readAs(consumeInput(i),type) : readAs(inputs[i],type),type);
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
      checks.push(`matches(${patterns(remaining)}, ${values(boxed.map((value,i) => at&&!preserveInputs ? ctx.move(value,boxed.filter((_,j) => i !== j)) : value))}, ${target})`);
    }
    const check = checks.length ? checks.join(' && ') : null;
    if (!at) {postMatch?.push(...matchedLocals);return check;}
    if (check) ctx.add(`if (!(${check})) fail(${at}, "Assignment pattern did not match");`);
    matchedLocals.forEach(bind=>bind());
    for (const name of patternNames(remaining)) {
      ctx.add(`${env}.bind(${string(name)}, ${target}.${optimizeVectors ? 'take' : 'read'}(${string(name)}), ${!!mutable.get(name)});`);
    }
    return null;
  }
  function branch(ctx, clause, inputs, env, trace, guardTrace = trace, ownParameters = false, types = []) {
    const count = clause.patterns.length;
    const patternValues = count ? inputs.slice(-count) : [];
    let state = count ? inputs.slice(0, -count) : [...inputs];
    ctx.add('{');
    const local = cloneEnv(ctx,env);
    const postMatch=[];
    const condition = bindPatterns(ctx,local,clause.patterns,patternValues,patternValues.map(representation),null,null,count?types.slice(-count):[],postMatch);
    ctx.add(condition ? `if (${condition}) {` : '{');
    postMatch.forEach(bind=>bind());
    if (clause.guard) {
      const guardEnv = cloneEnv(ctx,local);
      const pinned = ctx.pinned;
      ctx.pinned = new Set([...pinned,...inputs]);
      try { state = emit(clause.guard, state, guardEnv, new Map(), guardTrace, ctx); }
      finally { ctx.pinned = pinned; }
      if (state.never) {
        ctx.add('}', '}');
        return null;
      }
      ctx.add(`if (${readAs(state.pop(),'bool')}) {`);
    }
    if (optimizeVectors && ownParameters) for (const value of patternValues) {
      if (['Value','Adt'].includes(representation(value))) ctx.add(`${value}.reset();`);
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
    const parameters = args.map((arg,i) => `${inputTypes[i]} ${arg}`);
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
      lifetimePlans.set(analysis.trace,cppLifetimes(clause.body,analysis.trace,{parameters:patternNames(clause.patterns)}));
      const emitted = branch(ctx, clause, args, 'm.globals', analysis.trace, guard?.trace,true,ins);
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
    const call = `${spec.fn}(${['m',...args.map((value,i) => ctx.move(value,args.filter((_,j) => i !== j)))].join(', ')})`;
    if (spec.outputTypes.length === 1) stack.push(ctx.value(call,spec.outputTypes[0]));
    else {
      const result = id('results');
      ctx.add(`auto ${result} = ${call};`);
      spec.outputTypes.forEach((type,i) => stack.push(ctx.value(`std::get<${i}>(std::move(${result}))`,type)));
    }
  }
  function registerSite(node, env, body = node.body, type = null, captures = []) {
    const arities = [];
    if (type) {
      // Keep the creation context as well as the minimal stack effect. Loop
      // callbacks can carry an explicit prefix even when the body preserves it.
      const contextual = effectParts(T.instantiate(T.generalize(type)));
      const input = T.row();
      const analysis = ir.analyze(body,input,copyEnv(env),node.blockLabel);
      const minimal = effectParts(T.quote(input,analysis.output,analysis.effects));
      for (const shape of [contextual,minimal]) {
        arities.push({input:shape.input.length,output:shape.output.length,never:!!shape.output.never});
      }
    }
    const key = [...env].map(([name, scheme]) =>
      name + '=' + (scheme.callable ? 'function:' : 'value:') + formatType(scheme.type)).join(';') +
      ';arity=' + JSON.stringify(arities) + ';captures=' + JSON.stringify(captures);
    if (!sitesByNode.has(node)) sitesByNode.set(node, new Map());
    const existing = sitesByNode.get(node);
    if (existing.has(key)) return existing.get(key);
    if (sites.length >= 500) throw new Error('C++ quotation specialization limit exceeded');
    const site = sites.length;
    sites.push({site, node, body, env: copyEnv(env), arities, captures});
    existing.set(key, site);
    return site;
  }
  function invocation(effect, tailHandler = false) {
    const {input, output} = effectParts(effect);
    const key = signatureKey(input, output, effect) + (tailHandler ? ':handler' : '');
    if (invocations.has(key)) return invocations.get(key);
    if (invocations.size >= 500) throw new Error('C++ quotation call specialization limit exceeded');
    const fn = `invoke${invocations.size}`;
    const spec = {
      fn, input, output, key, tailHandler, effects:latent(effect), cases:new Map(),
      header:`${resultType(output.length)} ${fn}(${['Machine& m','const Value& value','const std::string& at',
        ...(tailHandler ? ['const Ptr<Continuation>& tailContinuation'] : []), ...params(input.length)].join(', ')})`
    };
    invocations.set(key, spec);
    return spec;
  }
  function inlineQuote(ctx,q,effect,stack,override = null,tail = false) {
    const known = override || knownQuotes.get(q);
    if (!known || known.ctx !== ctx || known.node.blockLabel || inlineDepth >= 12) return null;
    const parts = effectParts(effect), signature = freshTypes(parts.input,parts.output,latent(effect));
    const analysis = ir.analyze(known.node.body,signature.input,copyEnv(known.types));
    T.unify(analysis.output,signature.output,known.node);
    if (typedDispatch) T.specializeEffects(analysis.effects,signature.effects,known.node);
    if(nativeLocals&&known.lifetimes)lifetimePlans.set(analysis.trace,known.lifetimes);
    const enclosingTail = ctx.tailPositions;
    const inheritsTail = tail && stack.length === parts.input.length;
    // The caller can need its original state on another branch or cancellation.
    const inputs = take(stack,parts.input.length).map(value => ctx.nativePairs?.has(value) ? value :
      ctx.value(ctx.consumableInputs?.has(value)?`std::move(${value})`:value,representation(value)));
    const local = needsLocalEnv(known.node.body) ? cloneEnv(ctx,known.env) : known.env;
    inlineDepth++;
    ctx.tailPositions = inheritsTail ? tailPositions(known.node.body,analysis.trace) : null;
    let result;
    try { result = emit(known.node.body,inputs,local,new Map(),analysis.trace,ctx); }
    finally { inlineDepth--; ctx.tailPositions = enclosingTail; }
    const describe = () => ir.describe(analysis.trace,{kind:'inline-quotation',site:known.site},parts.input,parts.output);
    if (ctx.pendingDescriptions) ctx.pendingDescriptions.push(describe); else describe();
    if (result.never) return result;
    stack.push(...result);
    return stack;
  }
  function callQuote(ctx, q, effect, stack, at, {allowInline = false, handlerContinuation = null, tail = false} = {}) {
    if (allowInline) {
      const result = inlineQuote(ctx,q,effect,stack,null,tail);
      if (result) return result;
    }
    materializeQuote(q,ctx);
    const spec = invocation(effect, !!handlerContinuation);
    const handler = handlerContinuation ? [handlerContinuation] : [];
    stack.push(...ctx.call(spec.fn, ['m', q, at, ...handler, ...take(stack, spec.input.length)], spec.output.length));
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
    if (!native) return ctx.value(`bitOp<BitOp::${bitCodes.get(op) || op}>(m, ${a}, ${b}, ${loc(token)})`);

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
    const scalar = scalarCppType(type), rightType = scalarCppType(inputs?.at(-1)), op = token.value;
    if (bitwise.has(op) || bitPositions.has(op)) return callBit(ctx,token,a,b,scalar,rightType);
    if (scalar !== 'Value' && scalar === rightType) {
      const left = readAs(a,scalar), right = readAs(b,scalar);
      if (['==','/=','<','<=','>','>='].includes(op))
        return ctx.value(`${left} ${op === '/=' ? '!=' : op} ${right}`,'bool');
      if (scalar === 'bool' && ['&&','||'].includes(op))
        return ctx.value(`${left} ${op} ${right}`,'bool');
      if (scalar !== 'bool' && arithmetic.has(op)) {
        if (scalar === 'Int' && ['+','-','*'].includes(op))
          return ctx.value(`bits(static_cast<UInt>(${left}) ${op} static_cast<UInt>(${right}))`,scalar);
        const operation = {Int:'intOp',Byte:'byteOp',double:'floatOp'}[scalar];
        return ctx.value(`${operation}<Arithmetic::${arithmetic.get(op)}>(${left}, ${right}, ${loc(token)})`,scalar);
      }
    }
    if (['==','/=','<','<=','>','>='].includes(op)) {
      const eq = token.value === '==' || token.value === '/=';
      const call = type
        ? `${valueOperation(eq ? 'eq' : 'ord',type,token)}(m,${a},${b})`
        : `${eq ? 'equal' : 'compare'}(${a},${b})`;
      return ctx.value(eq ? (token.value === '/=' ? '!' : '') + call : `${call} ${token.value} 0`,'bool');
    }
    if (arithmetic.has(op)) return ctx.value(`numeric<Arithmetic::${arithmetic.get(op)}>(${a}, ${b}, ${loc(token)})`);
    if (op === 'cons') return ctx.value(`prepend(${a}, ${b})`);
    if (['vpush','push','Push','::'].includes(op)) {
      const native = vectorScalar(type);
      return ctx.value(native ? `scalarPush<${native}>(${ctx.move(a,[b])}, ${readAs(b,native)}, ${reuse})` : `append<false>(${ctx.move(a,[b])}, ${b}, ${reuse})`);
    }
    if (op === 'concat' || op === '++') {
      const container = type && T.prune(type);
      if (op === 'concat' || container?.tag === 'list') {
        const native = vectorScalar(type);
        return ctx.value(native ? `scalarConcat<${native}>(${ctx.move(a,[b])}, ${b}, ${reuse})` : `append<true>(${ctx.move(a,[b])}, ${b}, ${reuse})`);
      }
      if (container?.tag === 'atom' && container.name === 'string') return ctx.value(`concatStrings(${a}, ${b})`);
      return ctx.value(`concatValues(${ctx.move(a,[b])}, ${b}, ${reuse})`);
    }
    if (op === 'range' || op === '..' || op === '..=') {
      const left = readAs(a,'Int'), right = readAs(b,'Int');
      return ctx.value(op === 'range' ? `rangeVector(${left}, ${right})` : `Range{${left}, ${right}, ${op === '..='}}`);
    }
    if (op === '&&' || op === '||') return ctx.value(`${readAs(a,'bool')} ${op} ${readAs(b,'bool')}`,'bool');
    unsupported(token);
  }
  function callIndex(ctx, token, effect, args, optional = false) {
    const methodToken = {...token, value:args.length === 2 ? 'at' : 'setAt'};
    const target = customMethod(methodToken, effect);
    if (!target) {
      const native = vectorScalar(items(effect.input).at(-args.length));
      if (native && args.length === 2 && optional) return ctx.value(`typedOption(scalarFind<${native}>(${args[0]},${readAs(args[1],'Int')}))`,'Adt');
      if (native && args.length === 2 && !optional) return ctx.value(`scalarAt<${native}>(m,${args[0]},${readAs(args[1],'Int')},${loc(token)})`,native);
      if (native && args.length === 3) return ctx.value(`scalarSetAt<${native}>(m,${ctx.move(args[0],args.slice(1))},${readAs(args[1],'Int')},${readAs(args[2],native)},${optimizeVectors},${locView(token)})`);
      const sourceType=T.prune(items(effect.input).at(-args.length));
      if(nativeLocals&&nativeVectors&&!optional&&args.length===2&&sourceType.tag==='list'){
        const type=localType(sourceType.item);
        return ctx.value(`vectorElement<${type}>(m,as<Ptr<VectorBase>>(${args[0]}),${readAs(args[1],'Int')},${loc(token)})`,type);
      }
      if (optional) return ctx.value(`option(findIndex(${args.join(', ')}))`);
      const inputs = args.length === 2 ? args : [ctx.move(args[0],args.slice(1)),...args.slice(1)];
      return ctx.value(`${args.length === 2 ? 'atIndex' : 'setIndex'}(m, ${inputs.join(', ')}, ${loc(token)}${args.length === 3 ? ', ' + optimizeVectors : ''})`);
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
  function callSlice(ctx, token, effect, args) {
    const name=token.sliceMethod||token.value,target=customMethod({...token,value:name},effect);
    if(target){callNamed(ctx,target,effect,args);return args[0];}
    const native = vectorScalar(items(effect.input).at(-args.length));
    if (native) return ctx.value(`scalarSlice<${native}>(m,${args[0]},${name==='sliceTo'?'Int{0}':readAs(args[1],'Int')},${name==='sliceFrom'?'Int{0}':readAs(args.at(-1),'Int')},${name==='sliceFrom'},${loc(token)})`);
    return ctx.value(`sliceVector(m, ${args[0]}, ${name==='sliceTo'?'Int{0}':args[1]}, ${name==='sliceFrom'?'Int{0}':args.at(-1)}, ${name==='sliceFrom'}, ${loc(token)})`);
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
      const native=vectorScalar(type);
      if (native && kind!=='show' && !lookupInstance(definitions.classes.get(kind),[T.prune(type.item)])) {
        if (kind==='eq') ctx.add(`return equalScalarVectors<${native}>(m,a,b);`);
        else if (kind==='ord') ctx.add(`return compareScalarVectors<${native}>(a,b);`);
        else ctx.add(`return hashScalarVector<${native}>(a);`);
        return fn;
      }
      ctx.add('const auto& xs = as<Ptr<VectorBase>>(a)->items();');
      if (pair) {
        ctx.add('const auto& ys = as<Ptr<VectorBase>>(b)->items();');
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
    } else if (type.tag === 'adt' && type.name === 'set') {
      ctx.add('const auto& xs = *as<Ptr<HashSetBase>>(a);');
      if(kind==='eq')ctx.add('const auto& ys = *as<Ptr<HashSetBase>>(b);','if(xs.size()!=ys.size())return false;','for(const auto& pair:xs.keys())if(!ys.contains(pair))return false;','return true;');
      else if(kind==='hash')ctx.add('std::uint32_t sum=0;',`for(const auto& pair:xs.keys())sum+=${sub(type.args[0],'pair')};`,'return hashMix(hashMix(hashText("set"),xs.size()),sum);');
      else ctx.add('std::vector<std::string> parts;',`for(const auto& pair:xs.keys())parts.push_back(${sub(type.args[0],'pair')});`,'return "set ["+join(parts,", ")+"]";');
    } else if (type.tag === 'adt' && (['option','result'].includes(type.name) || kind === 'show') && type.name !== 'dict') {
      const constructors = [...definitions.constructors.values()].filter(c => c.typeName === type.name);
      if (constructors.length) {
        ctx.add('const auto& x = as<Adt>(a);');
        if (pair) ctx.add('const auto& y = as<Adt>(b);',`if (x.tag() != y.tag()) return ${kind === 'ord' ? 'compare(a,b)' : 'false'};`);
        for (const c of constructors) {
          const params = new Map(c.parameters.map((p,i)=>[p,type.args[i]]));
          const fields = c.fields.map(t=>T.syntaxType(t,params));
          const ctor = adts.constructors.get(c.name), layout=adts.layout(ctor,type,adtFieldType);
          ctx.add(`if (x.tag() == ${ctor.cpp}::tag) {`);
          const parts = fields.map((t,i)=>{
            const field=`adtField<${layout.family},${layout.cpp},${i}>`;
            const a=`${field}(x)`,b=`${field}(y)`;
            if (pair && ['Int','Byte','double','bool'].includes(layout.types[i]) &&
                !lookupInstance(definitions.classes.get(kind),[T.prune(t)]))
              return kind==='eq' ? `(${a} == ${b})` : `order(${a},${b})`;
            return sub(t,a,b);
          });
          if (pair) {
            for (const call of parts) ctx.add(check(call));
            ctx.add(kind === 'eq' ? 'return true;' : 'return 0;');
          } else if (kind === 'hash') {
            ctx.add('auto hash = x.info().hashSeed;');
            for (const call of parts) ctx.add(`hash=hashMix(hash,${call});`);
            ctx.add('return hash;');
          } else ctx.add(parts.length ? `return "("+std::string(x.info().display)+" "+join({${parts.join(',')}}, " ")+")";`
            : 'return std::string(x.info().display);');
          ctx.add('}');
        }
      }
      ctx.add(`return ${fallback};`);
    } else ctx.add(`return ${fallback};`);
    return fn;
  }

  function primitiveReplacement(nodes,trace,target) {
    return nodes.every(n=>{
      const info=trace.get(n);if(!info)return false;
      if(n.kind==='application')return primitiveReplacement(info.application,trace,target);
      if(n.kind==='scope')return primitiveReplacement(n.body,trace,target);
      if(n.kind==='literal'){
        if(typeof n.value==='number'&&n.numericKind!=='float'){
          const conversion=T.integerLiteralInfo(definitions,n,T.prune(info.output).item)?.conversion;
          if(conversion&&conversion.target!=='fromInt')return false;
        }
        return true;
      }
      if(['missing','reference'].includes(n.kind))return true;
      if(n.kind==='capture')return !n.slots.some(s=>s.capturedName);
      if(n.kind==='word')return n.value!==target&&info.env.has(n.value)&&!info.env.get(n.value).callable;
      if(n.kind==='binary')return !customMethod(n,info.operatorEffects?.[0])&&primitiveReplacement(n.left,trace,target)&&primitiveReplacement(n.right,trace,target);
      return false;
    });
  }
  function vectorUpdateStorage(node,info) {
    if(!node.updating||node.defaulting||!node.path.length)return null;
    let container;
    for(const [i,part] of node.path.entries()){
      const methods=info.indexPaths?.[i];
      if(part.kind!=='list-index'||!methods)return null;
      container=T.prune(items(methods.get.input).at(-2));
      if(container.tag!=='list')return null;
    }
    return vectorScalar(container)||'Value';
  }
  function emitVectorUpdate(ctx,node,source,indices,replace,storage,kept=[]) {
    const cell=ctx.vectorUpdateCell?.node===node?ctx.vectorUpdateCell.cell:'Ptr<Cell>{}';
    return ctx.value(`updateVectorAt<${storage}>(m, ${ctx.move(source,kept)}, {${indices.join(', ')}}, ${replace}, ${optimizeVectors}, ${cell}, ${loc(node)})`);
  }
  function vectorUpdateChain(q,container,callback,indices) {
    const known=knownQuotes.get(q);
    if(!known)return {container,callback};
    const captured=`as<Ptr<Quote>>(${q})->env`;
    let node=known.node,analysis;
    // Hoist only literal indices and reads of immutable bindings. An
    // optional outer index can skip every evaluation inside its quotation.
    while(optimizeVectors&&inlineDepth<12&&!node.blockLabel&&node.body.length===1&&node.body[0].kind==='application'){
      const [operation,index,next,...rest]=node.body[0].body;
      if(operation.kind!=='word'||!['updateAt','tryUpdateAt'].includes(operation.value)||
         next?.kind!=='quote'||next.blockLabel||rest.length||T.prune(container.item).tag!=='list')break;
      if(!analysis){
        const parts=effectParts(callback),signature=freshTypes(parts.input,parts.output,latent(callback));
        analysis=ir.analyze(node.body,signature.input,copyEnv(known.types));
        T.unify(analysis.output,signature.output,node);
        if(typedDispatch)T.specializeEffects(analysis.effects,signature.effects,node);
      }
      const info=analysis.trace.get(operation),binding=info?.env.get(index.value);
      if(!info?.effect||info.env.has(operation.value))break;
      let position;
      if(index.kind==='literal'&&index.numericKind==='integer')position=literal(index,'int');
      else if(index.kind==='word'&&binding&&!binding.mutable&&!binding.callable)
        position=readAs(readBinding(captured,index.value),'Int');
      else break;
      indices.push(`{${position}, ${operation.value==='tryUpdateAt'}, std::string_view(${stringLiteral(locText(operation))})}`);
      container=T.prune(container.item);
      callback=items(info.effect.input).at(-1);
      node=next;
    }
    return {container,callback,known:node===known.node?{...known,env:captured}:
      {...known,node,env:captured,types:analysis.trace.get(node).env,lifetimes:null}};
  }

  function emit(nodes, stack, env, holes, trace, ctx) {
    holes.references ??= new Map();
    if (!lifetimePlans.has(trace)) lifetimePlans.set(trace,cppLifetimes(nodes,trace,{local:env !== 'm.globals'}));
    const lifetimes = lifetimePlans.get(trace);
    const lowered = ir.instructions(nodes, trace, {local:env !== 'm.globals'});
    for (let instructionIndex=0;instructionIndex<lowered.length;instructionIndex++) {
      const instruction = lowered[instructionIndex];
      const n = instruction.source;
      const info = instruction.typing;
      if (!info) break;
      const at = loc(n);
      const reuse = optimizeVectors;
      const prior = [...stack], previousMove = ctx.move;
      const previousAliases = ctx.splitAliases;
      ctx.splitAliases = value => ctx.pinned.has(value) || [...holes.values(),...holes.references.values()].includes(value);
      const protectedValue = value => ctx.pinned.has(value) || stack.includes(value) || [...holes.values(),...holes.references.values()].includes(value);
      ctx.move = (value,other = []) => { materializeQuote(value,ctx); return optimizeVectors && /^(?:(?:v|arg|a)\d+|old|item)$/.test(value) &&
        managed(representation(value)) && !protectedValue(value) && !other.includes(value)
        ? `std::move(${value})` : value; };
      if (instruction.ir && optimizeVectors) {
        if (lifetimes.takes.has(n)) instruction.ir.memory = {binding:'take-if-unshared',reason:'last-use-before-write-or-scope-end'};
        if (canReuse.has(n.value) || n.kind === 'path-update' || ['setAt','updateAt','tryUpdateAt','hpush','hpop','qpush','qpushFront','qpop','qpopFront','qpopBack','pop','vpop'].includes(n.value)) {
          instruction.ir.ownership = {mode:'cow',reason:'runtime-reference-count',staticMode:instruction.ownership?.mode};
        }
      }
      const child = (body, initial = [], bindings = holes, into = ctx) => {
        const scope = needsLocalEnv(body) ? cloneEnv(into,env) : env;
        const pinned = into.pinned;
        into.pinned = new Set([...pinned,...(initial === stack ? [] : stack)]);
        let result;
        try { result = emit(body, initial, scope, bindings, trace, into); }
        finally { into.pinned = pinned; }
        if (result.never) throw new StoppedEmission();
        return result;
      };
      const get = name => readBinding(env,name);
      try {
        switch (n.kind) {
          case 'capture': {
            const removed = new Set();
            for (const slot of n.slots) {
              const value = stack.at(-1-slot.index);
              if (!slot.capturedName) holes.references.set(slot, value);
              if (slot.capturedName) ctx.add(`${env}.bind(${string(slot.capturedName)}, ${value});`);
              if (!slot.peek) removed.add(slot.index);
            }
            if (removed.size) stack = stack.filter((_, i) => !removed.has(stack.length-1-i));
            break;
          }
          case 'reference':
            stack.push(holes.references.get(n));
            holes.references.delete(n);
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
                stack.push(ctx.value(`cast<${castType.get(numeric.conversion.destination)}>(m, ${value}, ${at})`));
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
          case 'tuple': {
            const elements = child(n.body);
            const outputType = T.prune(info.output).item;
            const pair = nativeLocals && optimizeVectors && nativeVectors && nativePairTypes(n.kind==='list' ? T.prune(outputType).item : outputType);
            if (n.kind==='list' && pair && elements.length && new Set(elements).size===elements.length &&
                elements.every(value=>singleUseValue(pairLiterals.get(value),ctx,value,stack))) {
              const row = `std::tuple<${pair.join(',')}>`;
              for (const value of elements) {
                const {line,fields} = pairLiterals.get(value);
                ctx.lines[line] = `${row} ${value}{${fields.join(',')}};`;
                representations.set(value,row);
              }
              const rows=elements.map(value=>`std::move(${value})`).join(',');
              stack.push(ctx.value(`nativePairVector<${pair.join(',')}>(std::vector<${row}>{${rows}})`));
              break;
            }
            const owned = elements.map((value,i) => ctx.move(value,elements.filter((_,j) => i !== j)));
            const native = n.kind === 'list' && vectorScalar(outputType);
            const value=ctx.value(native ? `scalarVector<${native}>(std::vector<${native}>{${elements.map(value=>readAs(value,native)).join(', ')}})` : `${n.kind === 'list' ? 'vector' : 'tuple'}(${values(owned)})`);
            if (n.kind==='tuple' && pair) pairLiterals.set(value,{ctx,line:ctx.lines.length-1,fields:owned.map((field,i)=>readAs(field,pair[i]))});
            stack.push(value);
            break;
          }
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
            const fields = n.fields.map(f => `{${string(f.name)}, ${ctx.move(child(f.body, [], bound)[0])}}`);
            stack.push(ctx.value(`record({${fields.join(', ')}})`));
            break;
          }
          case 'dict': {
            const dictType=T.prune(T.prune(info.output).item);
            const dict = makeDict(ctx, dictType.args[0], n,dictType.args[1]);
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
          case 'tuple-index': {
            const source=stack.pop(), field=ctx.nativePairs?.get(source)?.[n.index];
            stack.push(field ? ctx.value(field,representation(field)) : ctx.value(`tupleAt(${source}, ${n.index})`));
            break;
          }
          case 'list-index': {
            if(n.sliceMethod){const source=stack.pop();stack.push(callSlice(ctx,n,info.indexGet,[source,...n.fields.map(f=>child(f.body)[0])]));break;}
            const source = stack.pop(), index = child(n.body)[0];
            stack.push(callIndex(ctx, n, info.indexGet, [source, index], n.optional));
            break;
          }
          case 'path-update': {
            const source = stack.pop();
            const args = n.fields.slice(0,-1).map(f => child(f.body)[0]);
            const [part] = n.path;
            const set = info.indexPaths?.[0]?.set;
            if (!n.updating && !n.defaulting && n.path.length === 1 && part.kind === 'list-index' && !part.optional &&
                set && vectorScalar(items(set.input).at(-3)) && !customMethod({...n,value:'setAt'},set)) {
              const replacement = child(n.fields.at(-1).body)[0];
              stack.push(callIndex(ctx,n,set,[source,args[part.argument],replacement]));
              break;
            }
            const storage=vectorUpdateStorage(n,info);
            if(instruction.ir&&storage&&ctx.vectorUpdateCell?.node===n)
              instruction.ir.memory={binding:'atomic-index-update',reason:'replacement-evaluation-before-cell-transfer'};
            const path = storage ? n.path.map(p=>`{${readAs(args[p.argument],'Int')}, ${!!p.optional}}`) : n.path.map((p, i) => {
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
            const optional = n.path.some(part => part.optional);
            const ambient = n.updating && !T.isBottom(info.output)
              ? items(T.prune(info.output).rest).map((type, i) => {
                const native = cppType(type);
                return ctx.value(optional ? readAs(stack[i], native) : native + '{}', native);
              })
              : [];
            inner.pinned = new Set([...ctx.pinned,...stack]);
            const result = emit(n.fields.at(-1).body, n.updating ? [...stack,'old'] : [], local,
              n.updating ? new Map() : holes, trace, inner);
            if (result.never) inner.add(`fail(${at}, "Non-returning update returned");`);
            else {
              const replacement = result.pop();
              assign(inner, ambient, result);
              inner.add(`return ${replacement};`);
            }
            const replace = `[&](Value old) -> Value {\n${inner.lines.join('\n')}\n}`;
            const updated = storage?emitVectorUpdate(ctx,n,source,path,replace,storage,args):
              ctx.value(`updatePath(m, ${ctx.move(source,args)}, {${path.join(', ')}}, 0, ${replace}, ${!!n.defaulting}, ${!!n.updating}, ${reuse}, ${at})`);
            if (n.updating) stack = ambient;
            stack.push(updated);
            break;
          }
          case 'quote': {
            const names = lifetimes.captures.get(n) || [];
            const site = registerSite(n,info.env,n.body,T.prune(info.output).item,captureLayout(env,names));
            const consumer = lowered.slice(instructionIndex+1).find(i => i.source.kind !== 'quote')?.source;
            const standard = definitions.get(consumer?.value)?.[0]?.token.file === '<standard>';
            const callbackConsumer = nativeLocals && lowered[instructionIndex+1]?.source === consumer &&
              (['map','filter','takeWhile','skipWhile','flatMap','chunkBy','groupBy','sortBy','maxiBy','miniBy','all','any','fromYield'].includes(consumer?.value) ||
                standard && consumer.value === 'repeatWith');
            const immediate = consumer?.kind === 'word' && !trace.get(consumer)?.env.has(consumer.value) &&
              (callbackConsumer || ['call','if','when','while','each','fold','vmap','vfilter','vscan','partitionPoint'].includes(consumer.value)) &&
              (!definitions.has(consumer.value) || standard && ['partitionPoint','repeatWith'].includes(consumer.value)) && !n.blockLabel;
            const directEnv = immediate && (nativeLocals || !needsLocalEnv(n.body));
            const captured = directEnv ? env : captureEnv(ctx,env,names);
            const value = immediate ? id('v') : ctx.value(quoteValue(site,captured));
            const scalarCaptures = names.flatMap(name=>{
              const local = bindings(env).get(name);
              return local && !managed(representation(local)) ? [[name,local]] : [];
            });
            knownQuotes.set(value,{node:n,env:captured,types:copyEnv(info.env),ctx,site,names,directEnv,deferred:immediate,lifetimes,scalarCaptures});
            if(instruction.ir&&nativeLocals&&directEnv)instruction.ir.memory={binding:'lexical-capture',reason:callbackConsumer?'compiled-callback':'synchronous-call'};
            stack.push(value);
            break;
          }
          case 'local-function': {
            const names = lifetimes.captures.get(n) || [];
            const site = registerSite(n,info.localEnv,n.body,null,captureLayout(env,names));
            const name = string(n.name);
            const captured = captureEnv(ctx,env,names);
            ctx.add(`${env}.bind(${name}, ${quoteValue(site,captured,name)});`);
            bindings(env).delete(n.name);
            cells(env).delete(n.name);
            break;
          }
          case 'bind': {
            const inputs = take(stack, n.patterns.length);
            const inputTypes = items(info.input);
            const types = inputTypes.slice(inputTypes.length-inputs.length).map(cppType);
            bindPatterns(ctx,env,n.patterns,inputs,types,new Map(n.names.map((name,i)=>[name,n.mutable[i]])),at,inputTypes.slice(inputTypes.length-inputs.length));
            if(instruction.ir&&nativeLocals&&env!=='m.globals'&&n.patterns.every(p=>p.kind==='word'))instruction.ir.memory={binding:n.mutable.some(Boolean)?'native-cell':'native-local',reason:'typed-lexical-storage'};
            break;
          }
          case 'update': {
            const names = n.names || [n.name];
            const flatten=nodes=>nodes.flatMap(node=>node.kind==='scope'?flatten(node.body):node.kind==='application'?flatten(trace.get(node).application):node.kind==='capture'&&!node.slots.length?[]:[node]);
            const ordered=flatten(n.body),operation=ordered.at(-1);
            if(optimizeVectors&&names.length===1&&ordered.length===3&&ordered[0].kind==='word'&&ordered[0].value===names[0]&&
                ['sinsert','sremove','qpush','qpushFront'].includes(operation?.value)&&primitiveReplacement([ordered[1]],trace,names[0])){
              const container=T.prune(T.prune(trace.get(ordered[0]).output).item),key=container.args?.[0];
              const primitive=key&&T.prune(key).tag==='atom'&&!lookupInstance(definitions.classes.get('hash'),[key])&&!lookupInstance(definitions.classes.get('eq'),[key]);
              if(container.name==='deque'||container.name==='set'&&primitive){
                const value=child([ordered[1]])[0],fn=container.name==='set'?`cellSetOp<${operation.value==='sinsert'?0:1}>`:`cellQueuePush<${operation.value==='qpush'?0:1}>`;
                ctx.add(`${fn}(${cellBinding(env,names[0])},${value});`);break;
              }
            }
            const simple=n.body.length===1&&n.body[0].kind==='scope'?n.body[0].body:n.body;
            const [owner,path]=simple;
            const isolatedPath=!path?.updating||(!stack.length&&!items(info.output).length);
            if(nativeLocals&&optimizeVectors&&isolatedPath&&names.length===1&&simple.length===2&&owner.kind==='word'&&owner.value===names[0]&&path.kind==='path-update'&&path.updating&&!path.defaulting&&path.path.length===1&&path.path[0].kind==='list-index'&&!path.path[0].optional){
              const container=T.prune(T.prune(trace.get(owner).output).item),row=container.tag==='list'&&T.prune(container.item),native=row&&vectorScalar(row);
              const parts=flatten(path.fields.at(-1).body),push=parts.at(-1);
              if(native&&parts.length===2&&push.kind==='word'&&['vpush','push','Push','::'].includes(push.value)&&!definitions.has(push.value)&&!customMethod(push,trace.get(push)?.effect)&&
                  primitiveReplacement(path.fields[0].body,trace,names[0])&&primitiveReplacement([parts[0]],trace,names[0])){
                const index=child(path.fields[0].body)[0],item=child([parts[0]])[0];
                ctx.add(`cellRowPush<${native}>(m,${cellBinding(env,names[0])},${readAs(index,'Int')},${readAs(item,native)},${at});`);
                if(instruction.ir)instruction.ir.memory={binding:'typed-row-update',reason:'primitive-evaluation-before-cell-transfer'};
                break;
              }
            }
            if(optimizeVectors&&isolatedPath&&names.length===1&&simple.length===2&&owner.kind==='word'&&owner.value===names[0]&&path.kind==='path-update'&&path.path.length===1&&path.path[0].kind==='list-index'&&!path.path[0].optional&&
                path.fields.every(field=>primitiveReplacement(field.body,trace,names[0]))){
              const container=T.prune(T.prune(trace.get(owner).output).item),native=vectorScalar(container);
              const dict=container.tag==='adt'&&container.name==='dict',keyType=dict&&T.prune(container.args[0]);
              const primitiveKey=dict&&keyType.tag==='atom'&&['int','byte','float','char','bool','string'].includes(keyType.name)&&!lookupInstance(definitions.classes.get('hash'),[keyType])&&!lookupInstance(definitions.classes.get('eq'),[keyType]);
              if(native&&!path.defaulting||primitiveKey){
                const index=child(path.fields[0].body)[0],inner=context();
                const result=emit(path.fields.at(-1).body,path.updating?['old']:[],env,path.updating?new Map():holes,trace,inner);
                if(!result.never&&result.length===1){
                  const replace=`[&](Value old)->Value {\n${inner.lines.join('\n')}\nreturn ${result[0]};\n}`;
                  ctx.add(native?`cellScalarSet<${native}>(m,${cellBinding(env,names[0])},${readAs(index,'Int')},${replace},${!!path.updating},${at});`:
                    `cellDictSet(m,${cellBinding(env,names[0])},${index},${replace},${!!path.updating},${!!path.defaulting},${at});`);
                  if(instruction.ir)instruction.ir.memory={binding:'atomic-index-update',reason:'primitive-evaluation-before-cell-transfer'};
                  break;
                }
              }
            }
            const previousCell=ctx.vectorUpdateCell;
            if(optimizeVectors&&n.updating&&names.length===1&&owner?.kind==='word'&&owner.value===names[0]){
              const target=simple.length===2&&path?.kind==='path-update'&&vectorUpdateStorage(path,trace.get(path))?path:
                ordered.length===4&&['updateAt','tryUpdateAt'].includes(operation?.value)?operation:null;
              if(target)ctx.vectorUpdateCell={node:target,cell:cellBinding(env,names[0])};
            }
            let output;
            try {output=child(n.body, n.updating ? stack : n.fromStack ? take(stack, names.length) : []);}
            finally {ctx.vectorUpdateCell=previousCell;}
            const replacements = take(output, names.length);
            if(n.updating) stack = output;
            names.forEach((name, i) => writeBinding(ctx,env,name,ctx.move(replacements[i],replacements.filter((_,j) => i !== j))));
            break;
          }
          case 'case': {
            const outputs = items(info.output).map(cppType).map(type => ctx.value(type+'{}',type));
            const matched = id('matched');
            ctx.add(`bool ${matched} = false;`);
            for (const clause of n.branches) {
              ctx.add(`if (!${matched}) {`);
              const result = branch(ctx, clause, stack, env, trace, trace,false,items(info.input));
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
            cells(scope).delete(n.key);
            stack = emit(n.body, stack, scope, holes, trace, ctx);
            break;
          }
          case 'mask':
          case 'borrow': {
            const inner = context(), local = cloneEnv(inner,env);
            if (n.kind === 'borrow') {
              const borrow = id('borrow');
              inner.add(`BorrowScope ${borrow}(${cellBinding(env,n.owner)});`,
                `${local}.bind(${string(n.reference)}, ${borrow}.ref);`);
              bindings(local).delete(n.reference);
              cells(local).delete(n.reference);
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
            stack = word(n, info, stack, ctx, env, reuse,lifetimes.takes.has(n));
            break;
          default:
            unsupported(n);
        }
        if (optimizeVectors && !['application','scope'].includes(n.kind)) for (const value of new Set(prior)) {
          if (/^(?:v|arg|a)\d+$/.test(value) && managed(representation(value)) && !protectedValue(value) && !knownQuotes.get(value)?.deferred) ctx.add(`${value}.reset();`);
        }
        if (stack.never) return stack;
        if (T.isBottom(info.output)) {
          ctx.add(`fail(${at}, "Non-returning computation returned");`);
          return neverValues();
        }
      } catch (error) {
        if (error instanceof StoppedEmission) return neverValues();
        throw error;
      } finally {
        ctx.move = previousMove;
        ctx.splitAliases = previousAliases;
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

  function trieScalar(type,key=false) {
    if(!nativeHashTries||!optimizeVectors||!type)return 'Value';
    type=T.prune(type);
    if(key&&(lookupInstance(definitions.classes.get('hash'),[type])||lookupInstance(definitions.classes.get('eq'),[type])))return 'Value';
    const native=cppType(type);
    return ['Int','Byte','double'].includes(native)?native:type.numericLiterals?'Int':'Value';
  }
  function makeDict(ctx, type, token, valueType=null) {
    const hash = valueOperation('hash',type,token);
    const dict = id('dict');
    const key=trieScalar(type,true),value=trieScalar(valueType);
    ctx.add(`Ptr<DictBase> ${dict} = std::make_shared<${key==='Value'&&value==='Value'?'Dict':`NativeDict<${key},${value}>`}>();`);
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
  const typedWalker = (source,type) => `[${source}](Machine& m, const TypedVisit<${type}>& visit) { walkTyped<${type}>(m,${source},visit); }`;
  function callback(ctx, q, effect, at, layout = null, output = 'Value', arity = 1) {
    const inner = context();
    const known = knownQuotes.get(q);
    const pair = Array.isArray(layout) ? layout : null;
    if (pair && (!known || known.node.blockLabel || inlineDepth>=12)) return null;
    const scalar = typeof layout === 'string' ? layout : null;
    const fields = pair && pair.map(type=>{
      const field=id('pairField');representations.set(field,type);return field;
    });
    const input = fields ? id('nativeTuple') : scalar || output !== 'Value' ? id('typedItem') : 'item';
    const args = arity ? [input] : [];
    if (scalar) representations.set(input,scalar);
    inner.consumableInputs = new Set([input]);
    if (fields) {
      inner.nativePairs = new Map([[input,fields]]);
      inner.pendingDescriptions = [];
    }
    const canInline = known?.ctx === ctx && !known.node.blockLabel && inlineDepth < 12;
    // A compiled lazy callback owns its captures. Only mutable bindings share
    // a cell, so updates made after creating the stream are still visible.
    const lexical = canInline && known.directEnv && known.names.every(name =>
      bindings(known.env).has(name) || cells(known.env).has(name));
    const env = lexical ? id('callbackEnv') : `as<Ptr<Quote>>(${q})->env`;
    const scalars = lexical ? known.names.filter(name=>bindings(known.env).has(name))
      .map(name=>[name,bindings(known.env).get(name)]) : canInline && !known.directEnv ? known.scalarCaptures : [];
    const shared = lexical ? known.names.filter(name=>cells(known.env).has(name))
      .map(name=>[name,cells(known.env).get(name)]) : [];
    let expanded;
    if (known && !known.node.blockLabel) {
      scalarBindings.set(env,new Map(scalars));
      cellBindings.set(env,new Map(shared));
      try { expanded = inlineQuote(inner,q,effect,[...args],{...known,ctx:inner,env}); }
      finally { scalarBindings.delete(env); cellBindings.delete(env); }
    }
    if (fields) {
      // Any reference to the whole tuple requires the regular boxed ABI.
      const reference = new RegExp('\\b'+input+'\\b');
      if (!expanded || expanded.includes(input) || inner.lines.some(line=>reference.test(line))) return null;
      inner.pendingDescriptions.forEach(describe=>describe());
    }
    if (!lexical) materializeQuote(q,ctx);
    const result = expanded || callQuote(inner, q, effect, args, at);
    if (!result.never && output !== 'void') inner.add(`return ${readAs(result[0],output)};`);
    if (lexical && inner.lines.some(line=>line.includes(env))) inner.lines.unshift(`Env ${env} = m.globals;`);
    const captures = [...new Set([...(lexical?[]:[q]),...scalars.map(([,value])=>value),...shared.map(([,cell])=>cell.ref)])];
    const parameters = fields ? fields.map((field,i)=>`const ${pair[i]}& ${field}`).join(', ') : `${scalar || 'Value'} ${input}`;
    return `[${captures.join(', ')}](Machine& m${arity ? ', '+parameters : ''}) -> ${output} {\n${inner.lines.join('\n')}\n}`;
  }
  function directPartitionPoint(n,info,stack,ctx) {
    const q = stack.at(-1), known = knownQuotes.get(q);
    if (!known || known.ctx !== ctx || known.node.blockLabel || inlineDepth >= 12) return false;
    const predicate = items(info.input).at(-1), parts = effectParts(predicate);
    const signature = freshTypes(parts.input,parts.output,latent(predicate));
    const probe = ir.analyze(known.node.body,signature.input,copyEnv(known.types));
    const effects = T.effectDescription(probe.effects);
    // Retain the ordinary function for effectful predicates, including routed
    // break/cancel, whose handler and rollback semantics must be preserved.
    if (effects.entries.length || effects.tails.length || T.isBottom(probe.output)) return false;
    const [source] = take(stack,2), state = stack.map(value => ctx.value(value,representation(value)));
    const lo = ctx.value('Int{0}','Int'), hi = ctx.value(`vectorLength(${source})`,'Int');
    const native = vectorScalar(items(info.input).at(-2));
    const data = native ? id('scalarData') : null;
    if (native) ctx.add(`auto ${data} = scalarData<${native}>(${source});`);
    ctx.add(`while (${lo} < ${hi}) {`);
    const mid = ctx.value(`${lo} + (${hi} - ${lo}) / 2`,'Int');
    const itemType = cppType(T.prune(items(info.input).at(-2)).item);
    const item = ctx.value(native ? `${data}->scalars()[static_cast<std::size_t>(${mid})]` : readAs(`as<Ptr<VectorBase>>(${source})->items()[static_cast<std::size_t>(${mid})]`,itemType),native || itemType);
    const output = inlineQuote(ctx,q,predicate,[...state,item]);
    const condition = output.pop();
    assign(ctx,state,output);
    ctx.add(`if (${readAs(condition,'bool')}) ${lo} = ${mid} + 1; else ${hi} = ${mid};`, '}');
    stack.splice(0,stack.length,...state,lo);
    return true;
  }
  function collectionQuery(ctx,n,info,stack) {
    const name=n.value, types=items(info.effect.input), type=T.prune(types.at(-1));
    const kind=collectionQueryType(type,name), source=stack.pop();
    if(!kind)unsupported(n,name);
    const ptr={vector:'VectorBase',dict:'DictBase',set:'HashSetBase',deque:'Queue',heap:'Collection'}[kind];
    const data=ptr?`as<Ptr<${ptr}>>(${source})`:kind==='string'?`as<std::string>(${source})`:`as<Range>(${source})`;
    if(name==='isEmpty'&&kind==='range'){
      stack.push(ctx.value(`rangeEmpty(${data})`,'bool'));
      return stack;
    }
    if(name!=='in'){
      const size=kind==='vector'?`vectorLength(${source})`:kind==='deque'?`${data}->size`:kind==='heap'?`${data}->values.size()`
        :kind==='string'?`${data}.size()`:`${data}->size()`;
      stack.push(ctx.value(name==='length'?`static_cast<Int>(${size})`:`${size} == 0`,name==='length'?'Int':'bool'));
      return stack;
    }
    const item=stack.pop(), itemType=types.at(-2);
    let test;
    if(kind==='range')test=`rangeContains(${data},${readAs(item,'Int')})`;
    else if(kind==='string')test=`${data}.find(utf8(as<Char>(${item}).code)) != std::string::npos`;
    else if(kind==='dict'||kind==='set')test=`${data}->contains(${item})`;
    else {
      const native=vectorScalar(type);
      if(native)test=`scalarContains<${native}>(${source},${readAs(item,native)})`;
      else {
        const values=kind==='vector'?`${data}->items()`:kind==='heap'?`${data}->values`:`queueItems(*${data})`;
        const eq=valueOperation('eq',itemType,n);
        test=`containsElement(m,${values},${item},[](Machine& m,const Value& a,const Value& b) -> bool { return ${eq}(m,a,b); })`;
      }
    }
    stack.push(ctx.value(test,'bool'));
    return stack;
  }
  function replaceOnBreak(ctx, stack, breakResult) {
    if (!stack.length) return;
    ctx.add(`if (${breakResult}) {`);
    assign(ctx, stack, stack.map((_, i) => `${breakResult}->at(${i})`));
    ctx.add('}');
  }

  function word(n, info, stack, ctx, env, reuse,takeBinding = false) {
    const name = n.value, at = loc(n), get = key => readBinding(env,key);
    const label = n.handlerLabel ? `as<Ptr<Label>>(${get(n.handlerLabel)})` : 'Ptr<Label>{}';
    const pop = () => stack.pop();
    const push = expression => stack.push(ctx.value(expression));
    const inputs = () => items(info.input);
    const outCount = () => items(info.output).length;
    const call = (q, effect, state = stack, into = ctx, tail = false) => callQuote(into,q,effect,state,at,{
      allowInline:into === ctx,tail:tail && into === ctx && ctx.tailPositions?.has(n)
    });
    if (info.env.has(name)) {
      const callable = info.env.get(name).callable;
      const type = callable ? 'Value' : localType(T.prune(info.output).item);
      const consumeBinding = optimizeVectors && takeBinding;
      const direct = bindings(env).get(name);
      const cell=cells(env).get(name);
      const value = direct && !managed(representation(direct)) ? direct
        : ctx.value(cell?.type===type ? readBinding(env,name,consumeBinding) : readAs(readBinding(env,name,consumeBinding),type),type);
      if (n.ephemeral) {
        bindings(env).delete(name);
        if (!direct && !cells(env).has(name)) ctx.add(`${env}.erase(${string(name)});`);
        cells(env).delete(name);
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
    if (method?.collectionQuery) return collectionQuery(ctx,n,info,stack);
    if (method?.collectionOperation) {
      const target=collectionOperationTarget(T.prune(info.effect.dispatchType),name);
      if(!target)unsupported(n);
      const operation={...n,value:target};
      if(target==='vpush'){
        const [source,item]=take(stack,2);
        stack.push(callBinary(ctx,operation,source,item,info.effect,reuse));
        return stack;
      }
      return collectionWord(operation,info,stack,ctx,label,reuse);
    }
    if (method?.indexUpdate) {
      const types=items(info.effect.input),container=T.prune(types.at(-3));
      if(container.tag==='list'){
        const [source,index,q]=take(stack,3),inner=context();
        const indices=[`{${readAs(index,'Int')}, ${name==='tryUpdateAt'}}`];
        const chain=vectorUpdateChain(q,container,types.at(-1),indices);
        const result=(chain.known&&inlineQuote(inner,q,chain.callback,['old'],{...chain.known,ctx:inner}))
          || callQuote(inner,q,chain.callback,['old'],at);
        inner.add(result.never?`fail(${at}, "Non-returning update returned");`:`return ${result[0]};`);
        const replace=`[&](Value old) -> Value {\n${inner.lines.join('\n')}\n}`;
        stack.push(emitVectorUpdate(ctx,n,source,indices,replace,vectorScalar(chain.container)||'Value',[index,q]));
        return stack;
      }
      callNamed(ctx, '__tc_'+name, info.effect, stack);
      return stack;
    }
    if (name === 'partitionPoint' && definitions.get(name)?.[0].token.file === '<standard>' && directPartitionPoint(n,info,stack,ctx)) return stack;
    if(['repeat','repeatWith'].includes(name)&&definitions.get(name)?.[0].token.file==='<standard>'){
      const value=stack.at(-1),known=knownQuotes.get(value);
      if(name==='repeat'||!known?.node.blockLabel){
        stack.pop();
        const type = nativeLocals && optimizeVectors ? streamRepresentation(T.prune(T.prune(info.output).item).item) : 'Value';
        const captured = name === 'repeat' ? ctx.value(readAs(value,type),type) : id('repeated');
        if (name === 'repeatWith') ctx.add(`auto ${captured} = ${callback(ctx,value,items(info.input).at(-1),at,null,type,0)};`);
        const result = name === 'repeat' ? captured : `${captured}(m)`;
        const factory = type === 'Value' ? 'stream' : `typedStream<${type}>`;
        const visitor = type === 'Value' ? 'Visit' : `TypedVisit<${type}>`;
        stack.push(ctx.value(`${factory}([${captured}](Machine& parent,const ${visitor}& visit) {
loop(parent,[&](Machine& m) { while(true) visit(${result}); });
})`));
        return stack;
      }
    }
    if (name === 'unzip' && definitions.get(name)?.[0].token.file === '<standard>') {
      const source = stack.pop(), type = items(info.input).at(-1);
      if(nativeLocals){
        const outputTypes=items(info.output),lt=outputTypes.at(-2),rt=outputTypes.at(-1),ln=vectorScalar(lt),rn=vectorScalar(rt);
        if (ln && rn && T.prune(type).tag==='list' && !lookupInstance(definitions.classes.get('streem'),[T.prune(type)])) {
          stack.push(...ctx.call(`unzipNativeVector<${ln},${rn}>`,[source],2));
          return stack;
        }
        const state=stack.map(value=>ctx.value(value,representation(value))),left=id('unzipped'),right=id('unzipped'),append=id('appendPair'),broken=id('breakResult');
        ctx.add(`${ln?'std::vector<'+ln+'>':'Values'} ${left};`,`${rn?'std::vector<'+rn+'>':'Values'} ${right};`);
        if(T.prune(type).tag==='list')ctx.add(`${left}.reserve(vectorLength(${source}));`,`${right}.reserve(vectorLength(${source}));`);
        ctx.add(`auto ${append} = [&](Value pair) {`,`const auto& fields=as<Ptr<Tuple>>(pair)->values;`,
          `${left}.push_back(${ln?'as<'+ln+'>(fields[0])':'fields[0]'});`,`${right}.push_back(${rn?'as<'+rn+'>(fields[1])':'fields[1]'});`,'};',
          `auto ${broken}=loop(m,[&](Machine& m){`, `(${walker(source,type,n)})(m,${append});`,'});',`if(${broken}) {`);
        assign(ctx,state,state.map((_,i)=>`${broken}->at(${i})`));
        ctx.add(`${left}.clear();${right}.clear();`,`for(const auto& pair:as<Ptr<VectorBase>>(${broken}->at(${state.length}))->items()) ${append}(pair);`,'}');
        state.push(ctx.value(vectorFactory(lt,`std::move(${left})`)),ctx.value(vectorFactory(rt,`std::move(${right})`)));
        stack.splice(0,stack.length,...state);return stack;
      }
      const gathered = collect(ctx,stack,walker(source,type,n),'Ptr<Label>{}');
      const pairs = gathered.pop(), left = id('unzipped'), right = id('unzipped');
      const outputTypes = items(info.output), leftType = outputTypes.at(-2), rightType = outputTypes.at(-1);
      const ln = vectorScalar(leftType), rn = vectorScalar(rightType);
      ctx.add(`${ln ? 'std::vector<'+ln+'>' : 'Values'} ${left};`, `${rn ? 'std::vector<'+rn+'>' : 'Values'} ${right};`,
        `${left}.reserve(as<Ptr<VectorBase>>(${pairs})->items().size());`,
        `${right}.reserve(as<Ptr<VectorBase>>(${pairs})->items().size());`,
        `for (const auto& pair : as<Ptr<VectorBase>>(${pairs})->items()) {`,
        `const auto& fields = as<Ptr<Tuple>>(pair)->values;`,
        `${left}.push_back(${ln ? 'as<'+ln+'>(fields[0])' : 'fields[0]'});`,`${right}.push_back(${rn ? 'as<'+rn+'>(fields[1])' : 'fields[1]'});`, '}');
      gathered.push(ctx.value(vectorFactory(leftType,`std::move(${left})`)),ctx.value(vectorFactory(rightType,`std::move(${right})`)));
      stack.splice(0,stack.length,...gathered);
      return stack;
    }
    if ((name === 'withHeap' || name === 'withDeque') && definitions.get(name)?.[0].token.file === '<standard>') {
      const [initial,q] = take(stack,2);
      const [containerType,bodyType] = inputs().slice(-2);
      const state = id('worklist');
      if (name === 'withHeap') {
        const item = T.prune(containerType).args[0], cmp = context();
        const less = callBinary(cmp,{...n,value:'<'},'a','b',comparisonEffect('<',item));
        ctx.add(`NativeHeapWorklist ${state}(${ctx.move(initial,[q])}, [&](const Value& a, const Value& b) {
${cmp.lines.join('\n')}
return truth(${less});
});`);
      } else ctx.add(`NativeDequeWorklist ${state}(${ctx.move(initial,[q])});`);
      const inner = context(), body = call(q,bodyType,[],inner);
      inner.add(body.never ? `fail(${at}, "Non-returning body returned");` : `return ${values(body)};`);
      const action = `withNativeWorklist(m, ${state}, [&](Machine& m) -> Values {
${inner.lines.join('\n')}
}, ${label})`;
      stack.push(...dynamicResults(ctx,action,outCount()-stack.length));
      return stack;
    }
    if (name === 'orderedCounts' && emitOrderedCounts(n,info,stack,ctx)) return stack;
    if (definitions.has(name)) {
      callNamed(ctx, name, info.effect, stack);
      return stack;
    }
    const constructor = definitions.constructors.get(name);
    if (constructor) {
      const args = take(stack, constructor.fields.length);
      const layout=adts.layout(adts.constructors.get(name),T.prune(info.output).item,adtFieldType);
      const fields=args.map((value,i)=>readAs(ctx.move(value,args.filter((_,j)=>i!==j)),layout.types[i]));
      stack.push(ctx.value(adts.make(layout,fields),'Adt'));
      return stack;
    }
    const operation = definitions.effects.get(name);
    if (operation) {
      const count = operation.syntax.input[0]?.tag === 'stack-row' ? stack.length : operation.inputCount;
      const args = take(stack, count);
      const target = n.target ? `labelTarget(${get(n.target)}, ${at})` : 'nullptr';
      const results = operation.syntax.output[0]?.tag === 'stack-row' ? items(info.effect.output).length : operation.outputCount;
      const worklist = operation.qualifiedName && nativeWorklistOperations.get(name);
      const event = destination => `m.perform(Event{${string(name)}, ${at}, ${values(args)}, ${operation.never}, ${destination}})`;
      if (worklist) {
        const destination = n.target ? ctx.value(target,'const void*') : target;
        const state = id('route'), result = results ? ctx.value('Value{}') : null;
        ctx.add(`if (auto* ${state} = nativeWorklistTarget(m, ${destination})) {`,
          `${result ? result+' = ' : ''}${state}->runWorklist(WorklistOperation::${worklist}, ${args[0] ?? 'Value{}'});`, '} else {');
        if (result) ctx.add(`${result} = std::move(${event(destination)}.at(0));`);
        else ctx.add(`${event(destination)};`);
        ctx.add('}');
        if (result) stack.push(result);
      } else stack.push(...dynamicResults(ctx,event(target),results));
      return stack;
    }
    if (binaryNames.has(name)) {
      const [a,b] = take(stack,2);
      stack.push(callBinary(ctx,n,a,b,info.effect,reuse && canReuse.has(name)));
    } else if (method?.specialCast) {
      const conversion = T.castInfo(definitions,n,info.effect);
      if (conversion.target !== name) callNamed(ctx, conversion.target, info.effect, stack);
      else {
        const value = pop(), [source, result] = conversion.types.map(cppType);
        const widening = source === result || result === 'double' || source === 'Byte' && result === 'Int';
        if (nativeLocals && representation(value)==='Char' && ['Int','double'].includes(result)) {
          stack.push(ctx.value(`static_cast<${result}>(${value}.code)`,result));
        } else if (nativeLocals && source !== 'Value' && result !== 'Value' && widening) {
          stack.push(ctx.value(`static_cast<${result}>(${readAs(value,source)})`,result));
        } else push(`cast<${castType.get(conversion.destination)}>(m, ${value}, ${at})`);
      }
    } else if (name === 'not') {
      stack.push(ctx.value(`!${readAs(pop(),'bool')}`,'bool'));
    } else if (['chars','bytes','vchars','vbytes'].includes(name)) {
      const kind = name.startsWith('v') ? 'textVector' : 'textStream';
      const walk = name.endsWith('chars') ? 'walkChars' : 'walkBytes';
      const text = pop();
      if (name==='bytes' && nativeLocals && optimizeVectors) push(`byteStream(${text})`);
      else if (name==='chars' && nativeLocals && optimizeVectors) push(`charStream(${text}, ${at})`);
      else if (name==='vbytes' && nativeLocals && vectorScalar(T.prune(info.output).item)==='Byte') push(`byteVector(${text})`);
      else push(`${kind}<${walk}>(${text}, ${at})`);
      if (name === 'bytes') knownByteStreams.set(stack.at(-1),{ctx,line:ctx.lines.length-1,text});
    } else if (['head','tail'].includes(name)) {
      const value = pop();
      if(name==='head'&&nativeLocals&&vectorScalar(inputs().at(-1))){const native=vectorScalar(inputs().at(-1));stack.push(ctx.value(`scalarHead<${native}>(${value},${at})`,native));}
      else push(`${name === 'head' ? 'vectorHead' : 'vectorTail'}(${value}, ${at})`);
    } else if (name === 'hash') {
      const operation = valueOperation('hash',inputs().at(-1),n);
      push(`static_cast<Int>(${operation}(m,${pop()}))`);
    } else if (method?.specialSlice) {
      stack.push(callSlice(ctx,n,info.effect,take(stack,name==='sliceBetween'?3:2)));
    } else if (name === 'at' || name === 'setAt') {
      stack.push(callIndex(ctx,n,info.effect,take(stack,name === 'at' ? 2 : 3)));
    } else if (['parseInt','parseFloat','toNum'].includes(name)) {
      const type = name==='parseInt' ? 'Int' : 'double', strict = name!=='toNum';
      const text = pop(), parse = representation(text)==='std::string' ? 'parseNumberText' : 'parseNumber';
      stack.push(ctx.value(`${parse}<${type}, ${strict}>(m, ${text}, ${at})`,strict ? nativeLocals ? type : 'Value' : 'Adt'));
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
    } else if (name === 'call') return call(pop(), inputs().at(-1),stack,ctx,true);
    else if (name === 'dip') {
      const [saved,q] = take(stack,2);
      const result = call(q,inputs().at(-1));
      if (!result.never) result.push(saved);
      return result;
    } else if (name === 'if' || name === 'when') {
      const [condition, yes, no] = take(stack,name === 'if' ? 3 : 2);
      const types = inputs(), outputs = items(info.output).map(cppType).map(type => ctx.value(type+'{}',type));
      ctx.add(`if (${readAs(condition,'bool')}) {`);
      const first = call(yes,types.at(no ? -2 : -1),[...stack],ctx,true);
      if (!first.never) assign(ctx,outputs,first);
      ctx.add('} else {');
      const second = no ? call(no,types.at(-1),[...stack],ctx,true) : stack;
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
    } else if (['each','fold','vmap','vfilter','vscan'].includes(name)) {
      return iterate(n, info, stack, ctx, label);
    } else if (name === 'compose') {
      const [a,b] = take(stack,2), types = inputs();
      const portable = t => {
        const {input,output} = effectParts(t), row = T.row();
        return T.mono(T.quote(T.stack(row,...input),T.stack(row,...output)));
      };
      const captured = new Map([['__a',portable(types.at(-2))],['__b',portable(types.at(-1))]]);
      const body = ['__a','call','__b','call'].map(value => ({...n,kind:'word',value}));
      const site = registerSite(n,captured,body,T.prune(info.output).item), e = id('env');
      ctx.add(`Env ${e};`, `${e}.bind("__a", ${a});`, `${e}.bind("__b", ${b});`);
      push(quoteValue(site,e));
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
        const result = callQuote(handler,ref,type,[...inputs,'Value{k}'],at,{handlerContinuation:effectCoroutines ? 'k' : null});
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
      if (ctx.tailPositions?.has(n) && stack.length === 0)
        ctx.add(`if (resumeTail(${k}, tailContinuation, ${values(args)}, ${at})) return {};`);
      stack.push(...dynamicResults(ctx,`resume(${k}, ${values(args)}, ${at})`,parts.output.length));
    } else if (name === 'fromYield') {
      push(`fromYield(${label}, ${callback(ctx,pop(),info.bodyType,at,null,'void',0)})`);
    } else {
      return collectionWord(n,info,stack,ctx,label,reuse);
    }
    return stack;
  }

  function iterate(n, info, stack, ctx, label) {
    const type = items(info.input), name = n.value, at = loc(n);
    const q = stack.pop(), acc = ['fold','vscan'].includes(name) ? stack.pop() : null, source = stack.pop();
    const split = knownSplits.get(source), bytes = knownByteStreams.get(source), quote = knownQuotes.get(q);
    const parser = quote?.node.body.filter(node => node.kind !== 'capture');
    if (name === 'vmap' && split?.ctx === ctx && quote?.ctx === ctx && !quote.node.blockLabel &&
        parser.length === 1 && parser[0].kind === 'word' && ['parseInt','parseFloat'].includes(parser[0].value) &&
        !definitions.has(parser[0].value) && !quote.types.has(parser[0].value) &&
        singleUseValue(split,ctx,source,stack)) {
      // The stream is consumed once here. Its producer can store the two
      // strings directly; no substring Values or type-erased walker are needed.
      ctx.lines[split.line] = `SplitInput ${source}{as<std::string>(${split.text}), as<std::string>(${split.separator})};`;
      representations.set(source,'SplitInput');
      const values = id('parsed'), broken = id('breakResult');
      const state = stack.map(value => ctx.value(value,representation(value)));
      const number = parser[0].value === 'parseInt' ? 'Int' : 'double';
      const native = vectorScalar(T.prune(info.output).item);
      ctx.add(`${native ? 'std::vector<'+native+'>' : 'Values'} ${values};`, `auto ${broken} = loop(m,[&](Machine& m) {`,
        `splitParts(${source},[&](std::string_view part) {`,
        `${values}.push_back(parseNumberText<${number},true>(m,part,${loc(parser[0])}));`, '});', `},${label});`);
      state.push(ctx.value(vectorFactory(T.prune(info.output).item,`std::move(${values})`)));
      replaceOnBreak(ctx,state,broken);
      return state;
    }
    const state = stack.map(v => ctx.value(v,representation(v)));
    const accumulatorType = acc ? cppType(type.at(-2)) : null;
    const accumulator = acc ? ctx.value(readAs(acc,accumulatorType),accumulatorType) : null;
    const collecting = name === 'vmap' || name === 'vfilter' || name === 'vscan';
    const collected = id('collected'), broken = id('breakResult'), walk = id('walk');
    const collectedNative = collecting ? vectorScalar(T.prune(info.output).item) : null;
    if (collecting) ctx.add(`${collectedNative ? 'std::vector<'+collectedNative+'>' : 'Values'} ${collected};`);
    if (name === 'vscan') ctx.add(`${collected}.push_back(${accumulator});`);
    const sourceType=T.prune(type.at(acc ? -3 : -2)),nativeItem=vectorScalar(sourceType);
    const inline = nativeLocals && quote?.ctx===ctx && !quote.node.blockLabel && inlineDepth<12;
    const directBytes = inline && singleUseValue(bytes,ctx,source,stack);
    const direct = inline && (directBytes || sourceType.tag==='list' || sourceType.name==='range');
    const typedItem = !direct && typedIterable(sourceType);
    let item='item', range=null, cursor=null;
    const release=[];
    if(direct){
      const itemType=directBytes?'Byte':sourceType.tag==='list'?localType(sourceType.item):'Int';
      item=id('scalarItem');representations.set(item,itemType);
      const data=id('iterationData');
      let owner=null,boxed=null,steal=null;
      if(directBytes){
        // Store the producer's input at its original evaluation point, then
        // traverse it without allocating a stream or boxing each byte.
        ctx.lines[bytes.line] = `std::string ${source} = as<std::string>(${bytes.text});`;
        representations.set(source,'std::string');
      }else if(sourceType.tag==='list'){
        owner=ctx.value(readAs(ctx.move(source),'Ptr<VectorBase>'),'Ptr<VectorBase>');release.push(owner);
        if(nativeItem){ctx.add(`auto ${data} = scalarData<${nativeItem}>(${owner});`);release.unshift(data);}
        else{boxed=id('boxed');steal=id('steal');ctx.add(`auto* ${boxed}=dynamic_cast<Vector*>(${owner}.get());`,`bool ${steal}=${boxed}&&!${boxed}->owner&&${owner}.use_count()==1;`);}
      }else ctx.add(`const auto ${data} = as<Range>(${source});`);
      ctx.add(`auto ${broken} = loop(m, [&](Machine& m) {`);
      if(directBytes)ctx.add(`for (Byte ${item} : ${source}) {`);
      else if(nativeItem)ctx.add(`for (${nativeItem} ${item} : ${data}->scalars()) {`);
      else if(owner){
        const index=id('index'),slot=`${boxed}->values[${index}]`,value=`${owner}->items()[${index}]`;
        ctx.add(`for(std::size_t ${index}=0;${index}<${owner}->size();++${index}) {`,
          `${itemType} ${item} = ${steal} ? ${itemType==='Value'?`std::move(${slot})`:`takeAs<${itemType}>(${slot})`} : ${readAs(value,itemType)};`);
      }
      else {range=data;cursor=id('cursor');ctx.add(`for(Int ${cursor}=${data}.first;;) {`,`if(${cursor}==${data}.last&&!${data}.inclusive)break;`,`Int ${item}=${cursor};`);}
    }else {
      if (typedItem) { item=id('typedItem'); representations.set(item,typedItem); }
      ctx.add(`auto ${walk} = ${typedItem ? typedWalker(source,typedItem) : walker(source,sourceType,n)};`,
        `auto ${broken} = loop(m, [&](Machine& m) {`, `${walk}(m, [&](${typedItem || 'Value'} ${item}) {`);
    }
    const previousConsumable=ctx.consumableInputs;
    if((direct||typedItem)&&name!=='vfilter')ctx.consumableInputs=new Set([item]);
    let output;
    try{output=callQuote(ctx,q,type.at(-1),[...state,...(acc ? [accumulator] : []),item],at,{allowInline:true});}
    finally{ctx.consumableInputs=previousConsumable;}
    if (!output.never) {
      if (name === 'vmap') {const value=output.pop();ctx.add(`${collected}.push_back(${readAs(ctx.move(value,output),collectedNative||'Value')});`);}
      if (name === 'vfilter') ctx.add(`if (${readAs(output.pop(),'bool')}) ${collected}.push_back(${ctx.move(item,output)});`);
      if (acc) {const value=output.pop();ctx.add(`${accumulator} = ${readAs(ctx.move(value,output),accumulatorType)};`);}
      if (name === 'vscan') ctx.add(`${collected}.push_back(${accumulator});`);
      assign(ctx,state,output);
    }
    if(range)ctx.add(`if(${cursor}==${range}.last)break;`,`${cursor} += ${range}.first>${range}.last ? -1 : 1;`);
    ctx.add(direct?'}':' });', `}, ${label});`);
    if (acc && name !== 'vscan') state.push(accumulator);
    if (collecting) state.push(ctx.value(vectorFactory(T.prune(info.output).item,`std::move(${collected})`)));
    replaceOnBreak(ctx,state,broken);
    release.forEach(value=>ctx.add(`${value}.reset();`));
    return state;
  }

  function collectionWord(n, info, stack, ctx, label, reuse) {
    const name = n.value, at = loc(n), types = items(info.input);
    const push = expression => stack.push(ctx.value(expression));
    if(name==='vpop'||name==='vpeek'){
      const source=stack.pop(),item=vectorScalar(types.at(-1))||'Value';
      if(name==='vpeek')stack.push(ctx.value(`vectorPeek<${item}>(${source})`,'Adt'));
      else {
        const result=id('popped');
        ctx.add(`auto ${result} = vectorPop<${item}>(${ctx.move(source)},${reuse});`);
        stack.push(ctx.value(`std::get<0>(std::move(${result}))`,'Adt'),ctx.value(`std::get<1>(std::move(${result}))`));
      }
      return stack;
    }
    if(name==='vreplicate'){
      const [count,value]=take(stack,2),native=vectorScalar(T.prune(info.output).item);
      const size=`static_cast<std::size_t>(countValue(m,${count},"vreplicate",${at}))`;
      push(native?`scalarVector<${native}>(std::vector<${native}>(${size},${readAs(value,native)}))`:`vector(Values(${size},${value}))`);return stack;
    }
    if(name==='__emptySet'){
      const type=T.prune(T.prune(info.output).item).args[0],hash=valueOperation('hash',type,n),eq=valueOperation('eq',type,n),out=id('set');
      const native=trieScalar(type,true);
      ctx.add(`Ptr<HashSetBase> ${out}=std::make_shared<${native==='Value'?'HashSet':`NativeSet<${native}>`}>();`,`${out}->hash=[&globals=m.globals](const Value& key){Machine m{globals,{}};return ${hash}(m,key);};`,`${out}->equal=[&globals=m.globals](const Value& a,const Value& b){Machine m{globals,{}};return ${eq}(m,a,b);};`);
      push(out);return stack;
    }
    if(['sinsert','sremove','scontains','slength','sisEmpty'].includes(name)){
      if(name==='slength'||name==='sisEmpty'){const source=stack.pop();push(name==='slength'?`static_cast<Int>(as<Ptr<HashSetBase>>(${source})->size())`:`as<Ptr<HashSetBase>>(${source})->size()==0`);return stack;}
      const [source,key]=take(stack,2),op={sinsert:0,sremove:1,scontains:2}[name];
      push(`setOp<${op}>(${ctx.move(source,[key])},${key})`);return stack;
    }
    if (transforms.has(name)) {
      const mode = transforms.get(name);
      const arg = mode === 'flatten' ? null : stack.pop(), source = stack.pop();
      const chunks = knownChunks.get(source), quote = knownQuotes.get(arg);
      if (name === 'map' && !n.handlerLabel && singleUseValue(chunks,ctx,source,stack) &&
          quote?.ctx === ctx && !quote.node.blockLabel && !quote.types.has('count') &&
          definitions.get('count')?.[0]?.token.file === '<standard>') {
        const body = quote.node.body.filter(node=>node.kind!=='capture' || node.slots.length);
        if (body.length===1 && body[0].kind==='word' && body[0].value==='count') {
          // The only observer of each group is count, so do not build its stream.
          ctx.lines[chunks.line] = `Value ${source} = partition<Partition::chunkBy,true>(${chunks.arguments});`;
          knownChunks.delete(source);
          stack.push(source);
          return stack;
        }
      }
      const type = T.prune(types.at(arg ? -2 : -1));
      const lazy = streamTransforms.has(name);
      const outputType = T.prune(info.output).item;
      const count = countTransform(mode) ? `countValue(m, ${arg}, ${string(name)}, ${at})` : '0';
      if (name==='map' && nativeLocals && optimizeVectors && nativeVectors && type.tag==='list' &&
          !lookupInstance(definitions.classes.get('streem'),[type])) {
        const pair = nativePairTypes(type.item), out = streamRepresentation(T.prune(outputType).item);
        const fn = pair && callback(ctx,arg,types.at(-1),at,pair,out);
        if (fn) {
          const layout = out === 'Value' ? pair : [...pair,out];
          push(`mapNativePairs<${layout.join(',')}>(${source},${fn},${label})`);
          return stack;
        }
      }
      const input = typedIterable(type);
      const item = streamRepresentation(T.prune(outputType).item);
      const nestedType = mode === 'flatten' ? T.iterableItem(type)
        : mode === 'flatMap' ? items(T.prune(types.at(-1)).output).at(-1) : null;
      const nestedItem = nestedType && typedIterable(nestedType);
      if ((!nestedType && input) || nestedItem || (nativeLocals && optimizeVectors && mode==='map' && item!=='Value')) {
        const nestedInput = mode === 'flatten' ? input || 'Value' : nestedItem ? localType(nestedType) : 'Value';
        const result = mode === 'map' ? item : predicateTransform(mode) ? 'bool' : nestedInput;
        const fn = !arg || countTransform(mode) ? 'nullptr'
          : callback(ctx,arg,types.at(-1),at,input,result);
        if (fn) {
          const walk = input ? typedWalker(source,input) : walker(source,type,n);
          const nested = nestedItem ? `,[](Machine& m, ${nestedInput} item, const TypedVisit<${nestedItem}>& visit) { walkTyped<${nestedItem}>(m,item,visit); }` : '';
          const transformed = ctx.value(`transformTyped<Transform::${mode},${input || 'Value'},${item}>(${walk},${count},${fn},${lazy?label:'Ptr<Label>{}'},${!lazy}${nested})`);
          if (lazy) stack.push(transformed);
          else return collect(ctx,stack,typedWalker(transformed,item),label,outputType,vectorScalar(outputType));
          return stack;
        }
      }
      const walk = walker(source,type,n);
      const fn = arg && !countTransform(mode) ? callback(ctx,arg,types.at(-1),at) : 'MapItem{}';
      const nested = nestedType ? `[](Machine& m, Value item, const Visit& visit) {
auto walkItem = ${walker('item',nestedType,n)};
walkItem(m,visit);
}` : '{}';
      const stream = ctx.value(`transform<Transform::${mode}>(${walk}, ${count}, ${fn}, ${lazy ? label : 'Ptr<Label>{}'}, ${!lazy}, ${nested})`);
      if (lazy) stack.push(stream);
      else return collect(ctx, stack, walker(stream,T.prune(info.output).item,n), label);
      return stack;
    }
    if (name === 'split') {
      const [source,separator] = take(stack,2);
      const line = ctx.lines.length, result = ctx.value(`split<${nativeLocals && optimizeVectors}>(${source}, ${separator})`);
      knownSplits.set(result,{text:source,separator,line,ctx});
      stack.push(result);
      return stack;
    }
    if (name === 'values') {
      const source = stack.pop();
      push(`stream([${source}](Machine&, const Visit& visit) {
for (const auto& pair : as<Ptr<DictBase>>(${source})->entries()) visit(pair.second);
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
      const vectors=T.prune(types.at(-2)).tag==='list'&&T.prune(types.at(-1)).tag==='list';
      const pair = !lazy && vectors && nativeLocals && nativeVectors && optimizeVectors &&
        nativePairTypes(T.prune(T.prune(info.output).item).item);
      if (pair) { push(`zipNativeVectors<${pair.join(',')}>(${left},${right})`); return stack; }
      const combined = ctx.value(vectors?`zipVectors(${left},${right},${lazy?label:'Ptr<Label>{}'})`:`zip(${walker(left,types.at(-2),n)}, ${walker(right,types.at(-1),n)}, ${lazy ? label : 'Ptr<Label>{}'})`);
      if (lazy) stack.push(combined);
      else return collect(ctx,stack,`[${combined}](Machine& m,const Visit& visit){ walk(m,${combined},visit); }`,label);
      return stack;
    }
    if (['windows','chunks','chunkBy'].includes(name)) {
      const [source,arg] = take(stack,2), keyed = name === 'chunkBy';
      const walk = walker(source,types.at(-2),n);
      const count = keyed ? '0' : `countValue(m, ${arg}, ${string(name)}, ${at}, true)`;
      const quote = knownQuotes.get(arg);
      const identity = quote && !quote.node.blockLabel && quote.node.body.every(node=>node.kind==='capture' && !node.slots.length);
      const key = keyed && !identity ? callback(ctx,arg,types.at(-1),at) : 'MapItem{}';
      const inner = context();
      const less = keyed && info.comparison ? callBinary(inner,{...n,value:'=='},'a','b',info.comparison) : null;
      const nativeKey = keyed && vectorScalar(T.prune(T.prune(types.at(-1)).output).item);
      const eq = less ? `[](Machine& m,const Value& a,const Value& b) { ${inner.lines.join(' ')} return truth(${less}); }` :
        ['Byte','Int'].includes(nativeKey) ? `equalScalarVectors<${nativeKey}>` : '{}';
      const arguments_ = `${walk}, ${count}, ${key}, ${eq}, ${label}`;
      push(`partition<Partition::${name}>(${arguments_})`);
      if (keyed && !n.handlerLabel && T.prune(types.at(-2)).tag==='list') {
        const effects=T.effectDescription(T.prune(types.at(-1)).effects);
        if (!effects.entries.length && !effects.tails.length)
          knownChunks.set(stack.at(-1),{ctx,line:ctx.lines.length-1,arguments:arguments_});
      }
      return stack;
    }
    if (['permutations','combinations','combinationsWithReplacement','powerset','cartesianProduct'].includes(name)) {
      const arg = name === 'powerset' ? null : stack.pop(), source = stack.pop();
      const right = name === 'cartesianProduct' ? walker(arg,types.at(-1),n) : 'Walk{}';
      const count = arg && name !== 'cartesianProduct' ? `countValue(m,${arg},${string(name)},${at})` : '0';
      push(`combinatorics<Combinatorics::${name}>(${walker(source,types.at(arg ? -2 : -1),n)}, ${right}, ${count})`);
      return stack;
    }
    if (['__emptyDeque','__emptyHeap','qpush','qpushFront','qpop','qpopFront','qpopBack','qpeek','qpeekBack','qlength','qisEmpty',
         'hpush','hpop','hpeek','hlength','hisEmpty'].includes(name)) {
      if (name === '__emptyDeque' || name === '__emptyHeap') {
        push(name==='__emptyDeque'?`std::make_shared<Queue>()`:`std::make_shared<Collection>(Collection{"heap", {}})`);
        return stack;
      }
      if(name.startsWith('q')){
        const op={qpush:0,qpushFront:1,qpop:2,qpopFront:2,qpopBack:3,qpeek:4,qpeekBack:5,qlength:6,qisEmpty:7}[name];
        const item=op<2?stack.pop():'Value{}',source=stack.pop();
        const [container,itemOption]=ctx.call(`queueOp<${op}>`,[source,item],2);
        if(op===2||op===3) stack.push(itemOption,container);
        else stack.push(container);
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
      const [container,itemOption]=ctx.call(`collectionOp<CollectionOp::${name}>`,[source,item,compare,String(reuse)],2);
      if(name==='hpop') stack.push(itemOption,container);
      else stack.push(container);
      return stack;
    }
    if (['vector','join','nth','reverse','sort','sortBy','maxi','mini','maxiBy','miniBy',
         'all','any','dict','counts','groupBy'].includes(name)) {
      return consume(n, info, stack, ctx, label);
    }
    unsupported(n);
  }
  function comparisonEffect(op, type) {
    const effect = T.instantiate(ir.functions.get(op));
    T.unify(effect.input,T.stack(T.EMPTY,type,type));
    return effect;
  }
  function emitOrderedCounts(n,info,stack,ctx) {
    if (!nativeLocals || !nativeVectors || !optimizeVectors || definitions.get(n.value)?.[0].token.file !== '<standard>' ||
        definitions.methods.get('==')?.className !== 'eq' ||
        ['sort','length','head','each','vpush','=='].some(name=>definitions.has(name) || ir.globals.has(name))) return false;
    const {input,output} = effectParts(info.effect);
    if (input.length!==1 || output.length!==1) return false;
    const pair = T.prune(T.prune(output[0]).item);
    const item = T.prune(pair.items[0]);
    const row = vectorScalar(item), scalar = cppType(item);
    const eqClass = definitions.classes.get('eq');
    if (lookupInstance(eqClass,[item])) return false;
    let eq;
    if (['Int','Byte'].includes(row) && !lookupInstance(eqClass,[T.prune(item.item)])) {
      eq = `equalScalarVectors<${row}>`;
    } else if (['Int','Byte','bool'].includes(scalar)) {
      eq = `[](Machine&,const Value& a,const Value& b){return as<${scalar}>(a)==as<${scalar}>(b);}`;
    } else return false;
    const sortInfo = {input:tuple(input),output:tuple([{tag:'list',item}]),comparison:comparisonEffect('<',item)};
    const [sorted] = consume({...n,value:'sort'},sortInfo,[stack.pop()],ctx,'Ptr<Label>{}');
    stack.push(ctx.value(`groupOrderedCounts<${localType(item)}>(m,${ctx.move(sorted)},${eq})`));
    return true;
  }
  function collect(ctx, stack, walk, label, resultType = null, native = null, order = null) {
    const result = id('items'), broken = id('breakResult');
    const state = stack.map(v => ctx.value(v));
    ctx.add(`${native ? 'std::vector<'+native+'>' : 'Values'} ${result};`, `auto ${broken} = loop(m,[&](Machine& m) {
(${walk})(m,[&](${native || 'Value'} typedItem){${result}.push_back(std::move(typedItem));});
}, ${label});`);
    if (order) {
      const method = order === 'sort' ? 'stable_sort' : 'reverse';
      ctx.add(`if (!${broken}) std::${method}(${result}.begin(), ${result}.end());`);
    }
    state.push(ctx.value(vectorFactory(resultType,`std::move(${result})`)));
    replaceOnBreak(ctx,state,broken);
    return state;
  }
  function consume(n, info, stack, ctx, label) {
    const name = n.value, types = items(info.input), at = loc(n);
    const withArg = ['join','nth','sortBy','maxiBy','miniBy','all','any','groupBy'].includes(name);
    const arg = withArg ? stack.pop() : null, source = stack.pop();
    const native = vectorScalar(types.at(-1));
    if (native && ['sort','reverse'].includes(name) && (name === 'reverse' || !customMethod({...n,value:'<'},info.comparison))) {
      stack.push(ctx.value(`scalarOrder<${native}>(${ctx.move(source)},${name === 'reverse'},${optimizeVectors})`));
      return stack;
    }
    if (name === 'vector') {
      const bytes = knownByteStreams.get(source), resultType=T.prune(info.output).item;
      if (nativeLocals && vectorScalar(resultType)==='Byte' && singleUseValue(bytes,ctx,source,stack)) {
        ctx.lines[bytes.line] = `Value ${source} = byteVector(${bytes.text});`;
        knownByteStreams.delete(source);
        stack.push(source);
        return stack;
      }
      const item = typedIterable(types.at(-1));
      if (item && item === vectorScalar(resultType)) return collect(ctx,stack,typedWalker(source,item),label,resultType,item);
      return collect(ctx,stack,walker(source,types.at(-1),n),label,resultType);
    }
    const sourceType = types.at(arg ? -2 : -1), walk = walker(source,sourceType,n);
    const itemType = typedIterable(sourceType);
    const order = name === 'reverse' || name === 'sort' && !customMethod({...n,value:'<'},info.comparison);
    if (order && itemType && itemType === vectorScalar(T.prune(info.output).item)) {
      return collect(ctx,stack,typedWalker(source,itemType),label,T.prune(info.output).item,itemType,name);
    }
    if (itemType && ['all','any'].includes(name)) {
      const predicate = callback(ctx,arg,types.at(-1),at,itemType,'bool');
      if (predicate) {
        const result = id('tested'), state = stack.map(value => ctx.value(value,representation(value)));
        ctx.add(`auto ${result} = testStream<${name==='all'},${itemType}>(m,${typedWalker(source,itemType)},${predicate},${label});`);
        state.push(ctx.value(`${result}.first`,'bool'));
        replaceOnBreak(ctx,state,`${result}.second`);
        return state;
      }
    }
    if (name === 'sort') {
      const item = T.prune(T.prune(info.output).item).item;
      const key = vectorScalar(item);
      if (['Int','Byte'].includes(key) && !customMethod({...n,value:'<'},info.comparison) &&
          !lookupInstance(definitions.classes.get('ord'),[T.prune(T.prune(item).item)])) {
        const result = id('sorted');
        const state = stack.map(value => ctx.value(value));
        const row = itemType === 'Ptr<VectorBase>' ? itemType : 'Value';
        ctx.add(`auto ${result} = sortScalarVectors<${key},${row}>(m,${row === 'Value' ? walk : typedWalker(source,row)},${label});`);
        state.push(ctx.value(`std::move(${result}.value)`));
        replaceOnBreak(ctx,state,`${result}.broken`);
        return state;
      }
    }
    const dict = ['dict','counts','groupBy'].includes(name)
      ? makeDict(ctx,T.prune(T.prune(info.output).item).args[0],n,T.prune(T.prune(info.output).item).args[1]) : null;
    const key = arg && !['join','nth'].includes(name) ? callback(ctx,arg,types.at(-1),at) : '{}';
    const cmp = context();
    const comparison = info.comparison && !['groupBy','all','any'].includes(name);
    const less = comparison ? callBinary(cmp,{...n,value:'<'},'a','b',info.comparison) : null;
    const compare = less ? `[](Machine& m, const Value& a,const Value& b) { ${cmp.lines.join(' ')} return truth(${less}); }` : '{}';
    const result = id('consumed');
    const state = stack.map(v => ctx.value(v));
    ctx.add(`auto ${result} = consume<Consume::${name}>(m,${walk},${['join','nth'].includes(name) ? arg : 'Value{}'},${key},${compare},${dict || '{}'},${label});`);
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
  function tailPositions(nodes, trace, sites = new Set()) {
    const last = nodes.findLast(node => node.kind !== 'capture' || node.slots.length);
    const info = trace.get(last);
    if (!info) return sites;
    if (last.kind === 'scope') tailPositions(last.body, trace, sites);
    if (last.kind === 'application') tailPositions(info.application, trace, sites);
    if (last.kind === 'case') for (const branch of last.branches) tailPositions(branch.body, trace, sites);
    if (last.kind === 'word') sites.add(last);
    return sites;
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const spec of invocations.values()) for (const {site,node,body,env,arities,captures} of sites) {
      if (!materializedSites.has(site)) continue;
      if (spec.cases.has(site)) continue;
      spec.cases.set(site,null);
      // A non-returning quotation can discard any preserved stack prefix.
      const compatibleArity = arities.length === 0 || arities.some(arity =>
        arity.never ? arity.input <= spec.input.length
          : arity.input === spec.input.length && arity.output === spec.output.length);
      if (!compatibleArity) continue;
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
      if (spec.tailHandler && !node.blockLabel) ctx.tailPositions = tailPositions(body,analysis.trace);
      scalarBindings.delete('local');
      cellBindings.delete('local');
      for (const capture of captures) {
        const {name,type,mutable} = capture;
        const cell = `local.cell(${string(name)})`;
        if (mutable) {
          const ref = ctx.value(`std::static_pointer_cast<NativeCell<${type}>>(${cell})`,`Ptr<NativeCell<${type}>>`);
          cells('local').set(name,{ref,type});
        } else {
          const slot = id('capturedSlot');
          ctx.add(`const ${type}& ${slot} = static_cast<const NativeCell<${type}>&>(*${cell}).value;`);
          representations.set(slot,type);
          bindings('local').set(name,slot);
        }
      }
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
  const body = `${declarations.join('\n')}

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
  const {includes,runtime,declarations:adtDeclarations} = emitCppRuntime(body,adts.fragments);
  if (onIR) onIR(ir.serialize());
  const source = `${batchIO ? '#define NYANCO_BATCH_IO 1\n' : ''}${includes}

namespace nyanco {
${runtime}
}

namespace nyanco {
${adtDeclarations}

${body}`;
  return lowerCppRc(effectCoroutines ? lowerCppCoroutines(source) : source, referenceCounting);
}
