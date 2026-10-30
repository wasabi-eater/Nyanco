import {typeName} from './type-names.mjs';
import {runtimeTypeKey} from './operator-classes.mjs';
import {expandClasses} from './type-classes.mjs';
import { typeSyntax, patternNames } from './type-syntax.mjs';

export class LanguageError extends Error {
  constructor(message, token) {
    super(token ? `${token.file}:${token.line}:${token.col}: ${message}` : message);
    this.name = 'LanguageError';
  }
}

export function lex(source, file = '<input>') {
  const tokens = [];
  let i = 0, line = 1, col = 1;
  const advance = () => { const c = source[i++]; if (c === '\n') { line++; col = 1; } else col++; return c; };
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) { advance(); continue; }
    if (source.startsWith('--', i)) { while (i < source.length && source[i] !== '\n') advance(); continue; }
    const token = { file, line, col, kind: 'word', value: '' };
    if ('[]{}();,#'.includes(c)) { token.kind = c; token.value = advance(); }
    else if (c === '"') {
      let raw = advance(), closed = false;
      while (i < source.length) {
        const next = advance(); raw += next;
        if (next === '\\' && i < source.length) raw += advance();
        else if (next === '"') { closed = true; break; }
      }
      if (!closed) throw new LanguageError('Unterminated string', token);
      try { token.value = JSON.parse(raw); } catch { throw new LanguageError('Invalid JSON-style string', token); }
      token.kind = 'literal';
    } else {
      const rest = source.slice(i);
      const signed = c === '-' && (i === 0 || /[\s([{;]/.test(source[i - 1]) || ['..','..='].includes(tokens.at(-1)?.value));
      const number = rest.match(signed ? /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/ : /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      const match = number || rest.match(/^(?:\.\.=|\.\.|\.\d+|\.[a-zA-Z_][a-zA-Z0-9_']*|=>|->|:=|::|==|\/=|<=|>=|\+\+|\$\d*|[:|!+\-*\/%^<>=]|'[a-z][a-zA-Z0-9_']*|[a-zA-Z_][a-zA-Z0-9_']*)/);
      if (!match) throw new LanguageError(`Unexpected character: ${c}`, token);
      for (let j = 0; j < match[0].length; j++) token.value += advance();
      if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(token.value)) {
        token.kind = 'literal'; token.value = Number(token.value);
        if (!Number.isFinite(token.value)) throw new LanguageError('Number must be finite', token);
      } else if (['True', 'False'].includes(token.value)) { token.kind = 'literal'; token.value = token.value === 'True'; }
    }
    tokens.push(token);
  }
  return tokens;
}

const OPERATORS = new Map([
  ['or', 1], ['and', 2], ['==', 3], ['/=', 3],
  ['<', 3], ['>', 3], ['<=', 3], ['>=', 3],
  ['..', 4], ['..=', 4], ['::', 4.5], ['+', 5], ['-', 5], ['++', 5], ['*', 6], ['/', 6], ['%', 6], ['^', 7],
]);
const isOperator = t => t?.kind === 'word' && OPERATORS.has(t.value);
const isComparison = t => t?.kind === 'word' && ['<','<=','>','>=','==','/='].includes(t.value);

function parseTokens(tokens, inherited = null, constructors = new Map()) {
  let i = 0;
  function scope(end, opener, context = null) {
    const nodes = [];
    // Parentheses share this lexical clause. References discovered later
    // belong to its entry capture; only quotation bodies start fresh clauses.
    const startClause=t=>{context.capture={...t,kind:'capture',slots:[]};nodes.push(context.capture);};
    if(!context){context={};startClause(opener || tokens[i]);}
    const done = () => i >= tokens.length || tokens[i].kind === end;
    const definitionAt=start=>{
      let depth=0;
      for(let k=start;k<tokens.length && tokens[k].line===tokens[start]?.line;k++) {
        const t=tokens[k];
        if(!depth && (t.kind===';' || t.kind==='word' && ['->',':=','!'].includes(t.value) || [')',']','}'].includes(t.kind)))break;
        if(!depth && t.kind==='word' && t.value==='=')return k;
        if(['(','[','{'].includes(t.kind))depth++;
        if([')',']','}'].includes(t.kind))depth--;
      }
      return -1;
    };
    const statement = () => definitionAt(i)>=0 || tokens[i]?.kind === 'word' && (tokens[i].value === 'mut' || tokens[i+1]?.kind === 'word' && [':=', '!'].includes(tokens[i+1].value));
    const boundary = () => done() || tokens[i].kind === ';' || statement() || (tokens[i].kind === 'word' && tokens[i].value === '->');
    function slot(t) {
      const index=Number(t.value.slice(1)||0),peek=t.value[0]==='$';
      if(!Number.isSafeInteger(index) || index>100000)throw new LanguageError('Stack reference index must be between 0 and 100000',t);
      if(context.capture.slots.some(s=>s.index===index && s.peek!==peek))throw new LanguageError(`Cannot mix _${index} and $${index} in the same clause`,t);
      const node={...t,kind:'reference',index,peek};context.capture.slots.push(node);return node;
    }
    const missing = t => ({ ...t, kind: 'missing' });
    function caseExpression(token) {
      const start=i,first=tokens[i];
      if(!first || !['->','|','otherwise'].includes(first.value))throw new LanguageError('case requires branches',token);
      const indent=first.col;let depth=0;const nested=[];
      while(i<tokens.length) {
        const t=tokens[i];
        if(!depth) {
          if(t.value==='end' && nested.length){nested.pop();i++;continue;}
          while(nested.length && t.line>nested.at(-1).line && t.col<nested.at(-1).col)nested.pop();
          if([')',']','}'].includes(t.kind) || !nested.length && (t.value==='end' || t.line>first.line && t.col<indent))break;
          if(t.value==='case' && tokens[i+1])nested.push(tokens[i+1]);
        }
        if(['(','[','{'].includes(t.kind))depth++;
        if([')',']','}'].includes(t.kind))depth--;
        i++;
      }
      const block=tokens.slice(start,i);
      if(tokens[i]?.value==='end')i++;
      const starts=[];depth=0;let branchThen=false;const inner=[];
      block.forEach((t,j)=>{
        if(!depth) {
          if(t.value==='end' && inner.length){inner.pop();return;}
          while(inner.length && t.line>inner.at(-1).line && t.col<inner.at(-1).col)inner.pop();
          if(t.value==='case' && block[j+1]){inner.push(block[j+1]);return;}
        }
        if(!depth && !inner.length && ['->','|','otherwise'].includes(t.value) && (j===0 || (t.col===indent || t.value==='|' && t.col>indent) && t.line>block[j-1].line || t.line===first.line && branchThen && t.value!=='->')){starts.push(j);branchThen=false;}
        if(!depth && !inner.length && t.value==='then')branchThen=true;
        if(['(','[','{'].includes(t.kind))depth++;
        if([')',']','}'].includes(t.kind))depth--;
      });
      const branches=[];let previous=[];
      for(let j=0;j<starts.length;j++) {
        const part=block.slice(starts[j],starts[j+1]??block.length),head=part[0];
        if(head.value==='otherwise') {
          if(j!==starts.length-1 || part.length<2)throw new LanguageError('otherwise must be the last case branch and have a body',head);
          branches.push({patterns:[],body:parseTokens(part.slice(1),null,constructors),token:head});continue;
        }
        let depth=0,then=-1,bar=-1;
        for(let k=1;k<part.length;k++) {
          const t=part[k];
          if(!depth && t.value==='then'){then=k;break;}
          if(!depth && t.value==='|')bar=k;
          if(['(','[','{'].includes(t.kind))depth++;
          if([')',']','}'].includes(t.kind))depth--;
        }
        if(then<0 || then===part.length-1)throw new LanguageError('case branch requires then and a body',head);
        const patterns=head.value==='->'?parsePatterns(part.slice(1,bar<0?then:bar),constructors):previous;
        if(head.value==='->')previous=patterns;
        const condition=head.value==='|'?part.slice(1,then):bar<0?null:part.slice(bar+1,then);
        if(condition && !condition.length)throw new LanguageError('Empty case guard',head);
        branches.push({patterns,guard:condition?parseTokens(condition,null,constructors):null,body:parseTokens(part.slice(then+1),null,constructors),token:head});
      }
      return {...token,kind:'case',branches};
    }
    function primary() {
      if (done()) return [missing(tokens[i - 1] || opener)];
      const t = tokens[i++];
      if(t.kind==='word' && t.value==='case')return [caseExpression(t)];
      if(t.kind==='#') {
        if(tokens[i++]?.kind!=='(')throw new LanguageError('Expected ( after #',t);
        return [{...t,kind:'tuple',body:scope(')',t,context)}];
      }
      if(t.kind==='word' && /^\.\d+$/.test(t.value)) {
        const index=Number(t.value.slice(1));
        if(!Number.isSafeInteger(index) || index>100000)throw new LanguageError('Tuple index must be between 0 and 100000',t);
        return [{...t,kind:'tuple-index',index}];
      }
      if(t.kind==='word' && /^\.[a-zA-Z_]/.test(t.value))return [{...t,kind:'field',name:t.value.slice(1)}];
      if(t.kind==='{' && (tokens[i]?.value===':' || tokens[i+1]?.value===':')) {
        const fields=[],names=new Set();
        if(tokens[i]?.value===':'){i++;if(tokens[i++]?.kind!=='}')throw new LanguageError('Expected } after {:',t);}
        else while(true) {
          const key=tokens[i++];
          if(key?.kind!=='word' || !/^[a-zA-Z_][a-zA-Z0-9_']*$/.test(key.value) || tokens[i++]?.value!==':')throw new LanguageError('Expected record field name:',key||t);
          if(names.has(key.value))throw new LanguageError(`Duplicate record field: ${key.value}`,key);
          names.add(key.value);
          const start=i;let depth=0;
          while(i<tokens.length){const x=tokens[i];if(!depth && [',','}'].includes(x.kind))break;if(['(','[','{'].includes(x.kind))depth++;if([')',']','}'].includes(x.kind))depth--;i++;}
          fields.push({name:key.value,body:i===start?[missing(key)]:parseTokens(tokens.slice(start,i),context,constructors)});
          const end=tokens[i++];if(end?.kind==='}')break;
          if(end?.kind!==',')throw new LanguageError('Unterminated record',t);
          if(tokens[i]?.kind==='}'){i++;break;}
        }
        return [{...t,kind:'record',fields}];
      }
      if(t.kind===',')throw new LanguageError('Unexpected comma',t);
      if ([')', ']', '}'].includes(t.kind)) throw new LanguageError(`Unexpected ${t.kind}`, t);
      if (['(', '[', '{'].includes(t.kind)) {
        const body = scope({ '(': ')', '[': ']', '{': '}' }[t.kind], t, t.kind!=='{'?context:null);
        return [{ ...t, kind: { '(': 'scope', '[': 'list', '{': 'quote' }[t.kind], body }];
      }
      if (t.kind === 'word' && /^[_$]\d*$/.test(t.value)) return [slot(t)];
      if (isOperator(t)) throw new LanguageError('Unexpected binary operator', t);
      if (t.kind === 'word' && ['=', ':=', '!', '|', 'data', 'mut', ':', '->'].includes(t.value)) throw new LanguageError(`Unexpected ${t.value}`, t);
      return [t];
    }
    function expression(min = 0) {
      // Juxtaposition forms an operand command sequence before infix parsing.
      // Only explicit separators, declarations, and scope ends split it.
      let left;
      if(isOperator(tokens[i])) left=[missing(tokens[i])];
      else {
        left=primary();
        while(!boundary() && !isOperator(tokens[i]))left.push(...primary());
      }
      while (!boundary() && isOperator(tokens[i]) && OPERATORS.get(tokens[i].value) >= min) {
        if(isComparison(tokens[i])) {
          const operands=[left],operators=[];
          do {
            const op=tokens[i++];operators.push(op);
            operands.push(boundary() || isComparison(tokens[i]) ? [missing(op)] : expression(3.1));
          } while(!boundary() && isComparison(tokens[i]));
          left=operators.length===1
            ? [{...operators[0],kind:'binary',left:operands[0],right:operands[1]}]
            : [{...operators[0],kind:'comparison-chain',operands,operators}];
          continue;
        }
        const op = tokens[i++], precedence = OPERATORS.get(op.value);
        // A leading operator in the RHS supplies a missing operand. The
        // precedence threshold decides whether it belongs here or to the parent.
        const right = boundary() ? [missing(op)] : expression(precedence + (op.value==='^' ? 0 : 0.1));
        left = [{ ...op, kind: 'binary', left, right }];
      }
      return left;
    }
    while (!done()) {
      if (tokens[i].kind === ';') { startClause(tokens[i++]); continue; }
      if(tokens[i].kind==='word' && tokens[i].value==='mut')throw new LanguageError('Declare mutable variables with value -> mut name',tokens[i]);
      const eq=definitionAt(i);
      if(eq>=0) {
        const first=tokens[i],name=tokens[eq-1],operator=tokens[eq];
        if(!name || name.kind!=='word' || !identifier.test(name.value) || ['_','mut','case','then','otherwise','end'].includes(name.value) || BUILTINS.has(name.value) || constructors.has(name.value))throw new LanguageError('Expected a local function name before =',name||first);
        const patterns=parsePatterns(tokens.slice(i,eq-1),constructors);i=eq+1;
        const start=i,multiline=tokens[i]?.line>operator.line,caseBody=tokens[i]?.kind==='word' && tokens[i]?.value==='case';let depth=0,cases=0;
        while(i<tokens.length) {
          const t=tokens[i];
          const closingCase=caseBody && t.kind==='word' && t.value==='end' && cases>0;
          if(!depth && ([')',']','}'].includes(t.kind) || !multiline && !caseBody && t.kind===';' || !closingCase && t.line>operator.line && t.col<=first.col))break;
          if(!depth && caseBody && t.kind==='word') {
            if(t.value==='case')cases++;
            if(closingCase && --cases===0){i++;break;}
          }
          if(['(','[','{'].includes(t.kind))depth++;
          if([')',']','}'].includes(t.kind))depth--;
          i++;
        }
        const parsed=parseTokens(tokens.slice(start,i),null,constructors);
        const body=patterns.length?[{...name,kind:'case',branches:[{patterns,body:parsed,token:name}]}]:parsed;
        const previous=nodes.findLast(n=>n.kind!=='capture');
        if(previous?.kind==='local-function' && previous.name===name.value && previous.parameterized && patterns.length)
          previous.body[0].branches.push(...body[0].branches);
        else nodes.push({...name,kind:'local-function',name:name.value,body,parameterized:patterns.length>0});
        if(i<tokens.length && tokens[i].kind!==';')startClause(tokens[i]);
        continue;
      }
      if (tokens[i].kind === 'word' && tokens[i + 1]?.kind === 'word' && [':=', '!'].includes(tokens[i + 1].value)) {
        const name = tokens[i++], operator = tokens[i++];
        if (!name || name.kind !== 'word' || !identifier.test(name.value) || ['_', 'mut', 'data'].includes(name.value) || BUILTINS.has(name.value))
          throw new LanguageError('Expected a variable name', name);
        const start = i;
        let depth = 0;
        while (i < tokens.length && (depth || tokens[i].kind !== end)) {
          const t = tokens[i];
          if (!depth && (t.kind === ';' || t.line > operator.line)) break;
          if (['(', '[', '{'].includes(t.kind)) depth++;
          if ([')', ']', '}'].includes(t.kind)) { if (!depth) break; depth--; }
          i++;
        }
        if (start === i) throw new LanguageError('Initializer requires a value', operator);
        // Expand x ! commands to x := x commands before parsing the RHS,
        // preserving exactly the same operator precedence and update checks.
        const rhs = tokens.slice(start, i);
        if (operator.value === '!') rhs.unshift(name);
        nodes.push({ ...name, kind:'update', name: name.value, body: parseTokens(rhs, context,constructors) });
        if(i<tokens.length && tokens[i].kind!==';' && tokens[i].line>operator.line)startClause(tokens[i]);
        continue;
      }
      if (tokens[i].kind === 'word' && tokens[i].value === '->') {
        const arrow=tokens[i++],parts=[],mutableNames=new Set();let depth=0;
        while(i<tokens.length && (depth || !done() && tokens[i].kind!==';' && tokens[i].line===arrow.line)) {
          const t=tokens[i++];
          if(t.value==='mut') {
            const name=tokens[i];
            if(!name || name.line!==t.line || !identifier.test(name.value) || name.value==='_' || BUILTINS.has(name.value))throw new LanguageError('Expected a variable after mut',t);
            mutableNames.add(name.value);continue;
          }
          if(['(','['].includes(t.kind))depth++;
          if([')',']'].includes(t.kind))depth--;
          parts.push(t);
        }
        const patterns=parsePatterns(parts,constructors),names=patternNames(patterns);
        if([...mutableNames].some(n=>!names.includes(n)))throw new LanguageError('mut must precede a pattern variable',arrow);
        if(!patterns.length)throw new LanguageError('Assignment requires at least one pattern',arrow);
        if(names.some(n=>BUILTINS.has(n)))throw new LanguageError('Assignment cannot bind built-ins',arrow);
        nodes.push({...arrow,kind:'bind',patterns,names,mutable:names.map(n=>mutableNames.has(n))});
        if(!done() && tokens[i].kind!==';')startClause(tokens[i]);
      } else nodes.push(...expression());
    }
    if (end) {
      if (i >= tokens.length) throw new LanguageError(`Missing ${end}`, opener);
      i++;
    }
    return nodes;
  }
  const result=scope(undefined, undefined, inherited);
  function clean(nodes) {
    return nodes.filter(n=>n.kind!=='capture'||n.slots.length).map(n=>{
      if(n.body)n.body=clean(n.body);
      if(n.kind==='record')for(const f of n.fields)f.body=clean(f.body);
      if(n.left){n.left=clean(n.left);n.right=clean(n.right);}
      if(n.operands)n.operands=n.operands.map(clean);
      return n;
    });
  }
  return inherited?result:clean(result);
}

export const parseExpression = (source, file, constructors) => parseTokens(lex(source, file),null,constructors);
const identifier = /^(?!_\d+$)[a-zA-Z_][a-zA-Z0-9_']*$/;

function dataDeclarations(groups, definitions, globals) {
  definitions.dataTypes = new Map(definitions.dataTypes);
  definitions.constructors = new Map(definitions.constructors);
  const pending=[];
  for (const group of groups) {
    if (group[0].kind !== 'word' || group[0].value !== 'data') continue;
    const eq=group.findIndex(t=>t.kind==='word' && t.value==='=');
    const postfix=group[1]?.value.startsWith("'") || /^[a-z]/.test(group[1]?.value || '');
    const originalName=group[postfix ? eq-1 : 1];
    const name=originalName && {...originalName,value:typeName(originalName.value)};
    if (!name || name.kind!=='word' || !/^[a-z][a-zA-Z0-9_']*$/.test(name.value) || ['data','mut'].includes(name.value) || eq<2)
      throw new LanguageError('Expected data Type parameters = Constructors',group[0]);
    if (['num','bool','string','int','range'].includes(name.value) || definitions.dataTypes.has(name.value))
      throw new LanguageError(`Type already declared: ${name.value}`,name);
    const parameters=group.slice(postfix ? 1 : 2,postfix ? eq-1 : eq).map(t=>{
      if(t.kind!=='word' || !(postfix ? /^'[a-z][a-zA-Z0-9_']*$/ : /^[a-z][a-zA-Z0-9_']*$/).test(t.value) || ['mut','data'].includes(t.value))
        throw new LanguageError('Type parameters must be lowercase names',t);
      return t.value;
    });
    if(new Set(parameters).size!==parameters.length) throw new LanguageError('Duplicate type parameter',name);
    const declaration={name:name.value,parameters,token:name,postfix};
    definitions.dataTypes.set(name.value,declaration);
    pending.push({declaration,tokens:group.slice(eq+1)});
  }
  for(const {declaration,tokens} of pending) {
    const alternatives=[[]];let depth=0;
    for(const t of tokens) {
      if(!depth && t.kind==='word' && t.value==='|') alternatives.push([]);
      else alternatives.at(-1).push(t);
      if(['(','[','{'].includes(t.kind))depth++;
      if([')',']','}'].includes(t.kind))depth--;
    }
    for(const alternative of alternatives) {
      const name=declaration.postfix ? alternative.at(-1) : alternative[0];
      const fields=declaration.postfix ? alternative.slice(0,-1) : alternative.slice(1);
      if(!name || name.kind!=='word' || !/^[A-Z][a-zA-Z0-9_']*$/.test(name.value))
        throw new LanguageError('Expected an uppercase constructor name',name || declaration.token);
      if(definitions.constructors.has(name.value) || definitions.has(name.value) || globals.has(name.value) || BUILTINS.has(name.value))
        throw new LanguageError(`Constructor name already used: ${name.value}`,name);
      if(fields.some(t=>t.kind==='literal'))throw new LanguageError('Constructor fields require types, not values',name);
      const parser=typeSyntax(fields.map(t=>t.value),definitions.dataTypes,new Set(declaration.parameters),message=>{throw new LanguageError(message,name);});
      const types=parser.types();
      definitions.constructors.set(name.value,{name:name.value,typeName:declaration.name,parameters:declaration.parameters,fields:types,token:name});
    }
  }
}

function parsePatterns(tokens, constructors) {
  let i=0;
  function atom() {
    const t=tokens[i++];
    if(!t)throw new LanguageError('Expected a pattern after ::',tokens[i-2]);
    if(t.kind==='(') {
      const inside=sequence(')');
      if(tokens[i++]?.kind!==')' || inside.length!==1)throw new LanguageError('A pattern group must contain one pattern',t);
      return inside[0];
    }
    if(t.kind==='#') {
      if(tokens[i++]?.kind!=='(')throw new LanguageError('Expected ( after # in tuple pattern',t);
      const fields=sequence(')');
      if(tokens[i++]?.kind!==')')throw new LanguageError('Missing ) in tuple pattern',t);
      return {...t,kind:'tuple-pattern',fields};
    }
    if(t.kind==='[') {
      const fields=sequence(']');
      if(tokens[i++]?.kind!==']')throw new LanguageError('Missing ] in list pattern',t);
      return {...t,kind:'list-pattern',fields};
    }
    if(t.kind==='literal')return t;
    if(t.kind==='word' && constructors.has(t.value) && constructors.get(t.value).fields.length===0)
      return {...t,kind:'constructor',fields:[]};
    if(t.kind==='word' && identifier.test(t.value) && !['mut','data'].includes(t.value)) {
      if(/^[A-Z]/.test(t.value))throw new LanguageError(`Unknown constructor or missing constructor fields: ${t.value}`,t);
      return t;
    }
    throw new LanguageError('Expected a literal, variable, wildcard, list or constructor pattern',t);
  }
  function cons(left) {
    while(tokens[i]?.kind==='word' && tokens[i].value==='::') {
      const t=tokens[i++];
      left={...t,kind:'push-pattern',fields:[left,atom()]};
    }
    return left;
  }
  function sequence(end) {
    const patterns=[];
    while(i<tokens.length && tokens[i].kind!==end) {
      const t=tokens[i];
      if(t.kind==='word' && (t.value==='Push' || constructors.has(t.value))) {
        i++;
        const count=t.value==='Push'?2:constructors.get(t.value).fields.length;
        if(patterns.length<count) throw new LanguageError(`Constructor pattern ${t.value} requires ${count} fields before its name`,t);
        const fields=count ? patterns.splice(-count) : [];
        patterns.push(cons({...t,kind:t.value==='Push'?'push-pattern':'constructor',fields}));
      } else patterns.push(cons(atom()));
    }
    return patterns;
  }
  const patterns=sequence(),names=patternNames(patterns);
  if(new Set(names).size!==names.length)throw new LanguageError('Duplicate pattern variable',tokens[0]);
  return patterns;
}

function matchPattern(pattern,value,bindings) {
  if(pattern.kind==='tuple-pattern')return value?.kind==='tuple' && pattern.fields.length===value.items.length && pattern.fields.every((p,i)=>matchPattern(p,value.items[i],bindings));
  if(pattern.kind==='literal')return equal(pattern.value,value);
  if(pattern.kind==='list-pattern')return Array.isArray(value) && value.length===pattern.fields.length && pattern.fields.every((p,i)=>matchPattern(p,value[i],bindings));
  if(pattern.kind==='push-pattern')return Array.isArray(value) && value.length>0 && matchPattern(pattern.fields[0],value.slice(0,-1),bindings) && matchPattern(pattern.fields[1],value.at(-1),bindings);
  if(pattern.kind==='constructor')return value?.kind==='adt' && value.constructor===pattern.value && value.fields.length===pattern.fields.length && pattern.fields.every((p,i)=>matchPattern(p,value.fields[i],bindings));
  if(pattern.value!=='_')bindings.set(pattern.value,value);
  return true;
}

export function compile(source, file = '<input>', previous = new Map(), { checkTypes = true, globals = new Map() } = {}) {
  const tokens = lex(source, file), groups = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.col === 1 && depth === 0 && !(token.kind==='word' && ['|','end'].includes(token.value))) groups.push([]);
    if (!groups.length) throw new LanguageError('Top-level declarations must start in column 1', token);
    groups.at(-1).push(token);
    if (['[', '{', '('].includes(token.kind)) depth++;
    if ([']', '}', ')'].includes(token.kind)) depth--;
  }
  const definitions = new Map(previous), local = new Set(), signatures = new Map();
  definitions.dataTypes=previous.dataTypes;
  definitions.constructors=previous.constructors;
  dataDeclarations(groups,definitions,globals);
  definitions.effects=new Map(previous.effects||[]);
  for(const group of groups)if(group[0].value==='effect') {
    const token=group[0],colonIndex=group.findIndex(t=>t.value===':'),name=group[colonIndex-1],parameters=group.slice(1,colonIndex-1).map(t=>t.value),signature=group.slice(colonIndex+1);
    if(colonIndex<2 || !name || !/^[a-z][A-Za-z0-9_']*$/.test(name.value) || parameters.some(p=>!/^'[a-z][A-Za-z0-9_']*$/.test(p)))throw new LanguageError("Expected effect 'a name : inputs -> outputs",token);
    if(new Set(parameters).size!==parameters.length)throw new LanguageError('Duplicate effect type parameter',token);
    if(definitions.effects.has(name.value)||definitions.has(name.value)||BUILTINS.has(name.value)||definitions.constructors.has(name.value)||globals.has(name.value))throw new LanguageError(`Effect name already used: ${name.value}`,name);
    const parser=typeSyntax(signature.map(t=>t.value),definitions.dataTypes,new Set(parameters),m=>{throw new LanguageError(m,token);});
    const syntax=parser.effect();if(!parser.done())throw new LanguageError('Unexpected effect signature token',token);
    const used=new Set();const visit=t=>{if(t && typeof t==='object'){if(t.tag==='param')used.add(t.name);if(typeof t.tail==='string')used.add(t.tail);Object.values(t).forEach(v=>Array.isArray(v)?v.forEach(visit):visit(v));}};visit(syntax);
    for(const p of parameters)if(!used.has(p))throw new LanguageError(`Unused effect type parameter: ${p}`,token);
    definitions.effects.set(name.value,{name:name.value,parameters,syntax,inputCount:syntax.input.length,outputCount:syntax.output.length,never:!!syntax.never,token});
  }
  definitions.initializers = [];
  const expanded=expandClasses(groups.filter(g=>g[0].value!=='effect'),definitions,previous,BUILTINS,globals);
  for(const name of definitions.effects.keys())if(definitions.methods.has(name))throw new LanguageError(`Effect conflicts with class method: ${name}`);
  for (const group of expanded) {
    const [first, second] = group;
    if(first.kind==='word' && first.value==='data')continue;
    if(first.kind==='word' && first.value==='mut')throw new LanguageError('Declare mutable variables with value -> mut name',first);
    let level=0;const outer=group.filter(t=>{
      const top=level===0;
      if(['(','[','{'].includes(t.kind))level++;
      if([')',']','}'].includes(t.kind))level--;
      return top;
    });
    if (outer.some(t => t.kind === 'word' && t.value === '->') && !outer.some(t => t.kind === 'word' && (t.value === '=' || t.value === ':'))) {
      definitions.initializers.push(...parseTokens(group,null,definitions.constructors)); continue;
    }
    if (second?.kind === 'word' && second.value === ':') { signatures.set(first.value, group.slice(2).map(t => t.value).join(' ')); continue; }
    const separators=[];let nesting=0;
    group.forEach((t,i)=>{
      if(!nesting && t.kind==='word' && ['|','='].includes(t.value))separators.push(i);
      if(['(','[','{'].includes(t.kind))nesting++;
      if([')',']','}'].includes(t.kind))nesting--;
    });
    const header=separators[0];
    if (header===undefined || header<1) throw new LanguageError('Expected [patterns] name = body or name | condition = body', first);
    const name = group[header - 1];
    if (!identifier.test(name.value) || name.kind !== 'word' || ['_', 'mut', 'data'].includes(name.value)) throw new LanguageError('Expected a function name before =', name);
    if(definitions.effects.has(name.value))throw new LanguageError(`Cannot redefine effect: ${name.value}`,name);
    if(definitions.methods.has(name.value))throw new LanguageError(`Cannot redefine class method: ${name.value}`,name);
    if(name.value.startsWith('__tc_') && !name.internal)throw new LanguageError('Reserved instance implementation name',name);
    if (BUILTINS.has(name.value)) throw new LanguageError('Cannot redefine a built-in word', name);
    if(definitions.constructors.has(name.value))throw new LanguageError(`Cannot redefine constructor: ${name.value}`,name);
    const patterns = parsePatterns(group.slice(0, header - 1),definitions.constructors);
    if (!local.has(name.value)) { definitions.set(name.value, []); local.add(name.value); }
    const clauses = definitions.get(name.value);
    if (clauses.length && clauses[0].patterns.length !== patterns.length) throw new LanguageError('All clauses must have the same arity', name);
    if(group[header].value==='=') {
      clauses.push({patterns,body:parseTokens(group.slice(header+1),null,definitions.constructors),token:name});
    } else {
      const bars=separators.filter(i=>group[i].value==='|' && (group[i].line===group[header].line || group[i].col===group[header].col));
      for(let j=0;j<bars.length;j++) {
        const start=bars[j],end=bars[j+1]??group.length;
        const eq=separators.find(i=>i>start && i<end && group[i].value==='=');
        if(eq===undefined || eq===start+1 || eq+1===end)throw new LanguageError('Guard requires a condition and = body',group[start]);
        const condition=group.slice(start+1,eq);
        const guard=condition.length===1 && condition[0].value==='otherwise'
          ? [{...condition[0],kind:'literal',value:true}] : parseTokens(condition,null,definitions.constructors);
        clauses.push({patterns,guard,body:parseTokens(group.slice(eq+1,end),null,definitions.constructors),token:name});
      }
    }
  }
  for(const c of definitions.classes.values())for(const inst of c.instances.values())for(const [n,s] of inst.signatures||[])signatures.set(n,s);
  for (const name of signatures.keys()) if (!definitions.has(name)) throw new LanguageError(`Signature without definition: ${name}`);
  for (const [name,signature] of signatures) {
    const clauses = [...definitions.get(name)]; clauses.signature = signature; definitions.set(name,clauses);
  }
  const types = checkTypes ? checkDefinitions(definitions,globals) : new Map();
  return { definitions, signatures, types };
}

export function format(value) {
  if(value?.kind==='continuation')return '<continuation>';
  if(value?.kind==='range')return `(${value.start} ${value.inclusive?'..=':'..'} ${value.end})`;
  if(value?.kind==='tuple')return `#(${value.items.map(format).join(' ')})`;
  if(value?.kind==='record')return Object.keys(value.fields).length ? `{${Object.keys(value.fields).sort().map(k=>`${k}: ${format(value.fields[k])}`).join(', ')}}` : '{:}';
  if (Array.isArray(value)) return `[${value.map(format).join(' ')}]`;
  if (value?.kind === 'closure') return '{ ... }';
  if (value?.kind === 'adt') return value.fields.length ? `(${value.fields.map(format).join(' ')} ${value.constructor})` : value.constructor;
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return String(value);
}
function equal(a, b) {
  if(a?.kind==='range' && b?.kind==='range')return a.start===b.start && a.end===b.end && a.inclusive===b.inclusive;
  if(a?.kind==='tuple' && b?.kind==='tuple')return equal(a.items,b.items);
  if(a?.kind==='record' && b?.kind==='record')return Object.keys(a.fields).length===Object.keys(b.fields).length && Object.keys(a.fields).every(k=>Object.hasOwn(b.fields,k) && equal(a.fields[k],b.fields[k]));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  if(a?.kind==='adt' && b?.kind==='adt')return a.typeName===b.typeName && a.constructor===b.constructor && equal(a.fields,b.fields);
  return a === b;
}

export class VM {
  constructor({ definitions = new Map(), output = console.log, maxSteps = 100000, maxDepth = 200, checkTypes = true } = {}) {
    this.definitions = definitions; this.output = output; this.maxSteps = maxSteps; this.maxDepth = maxDepth;
    this.globals = new Map();
    this.checkTypes = checkTypes;
  }
  execute(nodes, stack = []) {
    const pending = this.initialized === this.definitions ? [] : this.definitions.initializers || [];
    this.typePlan = {};
    if (this.checkTypes) checkExpression(nodes,this.definitions,this.globals,stack,this.typePlan, !pending.length);
    this.steps = 0; this.depth = 0;
    const previous = this.globals;
    this.globals = new Map(previous);
    this.globals.locals = new Set(previous.keys());
    this.journal = new Map();
    try {
      this.finish(this.run(pending, [], this.globals));
      this.finish(this.run(nodes, stack, this.globals));
      for (const [cell, type] of this.typePlan.cells || []) cell.staticType = type;
      this.initialized = this.definitions;
      return stack;
    } catch (error) {
      for (const [cell, value] of this.journal) cell.value = value;
      this.globals = previous; throw error;
    }
  }
  finish(generator) {
    try {const result=generator.next();if(!result.done)throw new LanguageError(`Unhandled effect: ${result.value.operation.name}`,result.value.token);}
    finally {generator.return();}
  }
  *handle(generator,values,handlers,token,initial) {
    let result=generator.next(initial);
    while(!result.done) {
      const request=result.value,handler=handlers.fields[request.operation.name];
      if(!handler){const returned=yield request;result=generator.next(returned);continue;}
      const vm=this,k={kind:'continuation',used:false,active:true,never:request.operation.never,inputCount:request.operation.outputCount,
        *resume(returned){return yield* vm.handle(generator,values,handlers,token,returned);}};
      const local=[...request.args,k];
      try {yield* this.call(handler,local,request.token);return local;}
      finally {k.active=false;generator.return();}
    }
    return values;
  }
  evaluate(source, stack = [], file = '<eval>') { return this.execute(parseExpression(source, file,this.definitions.constructors), stack); }
  infer(source, file = '<type>') { return inferExpression(parseExpression(source,file,this.definitions.constructors),this.definitions,this.globals, this.initialized === this.definitions); }
  declare(env, name, value, mutable, token, index = 0) {
    if(this.definitions.constructors?.has(name))throw new LanguageError(`Cannot shadow constructor: ${name}`,token);
    if (env.locals.has(name)) throw new LanguageError(`Variable already declared: ${name}`, token);
    if (env === this.globals && this.definitions.has(name)) throw new LanguageError(`Global variable conflicts with function: ${name}`, token);
    env.locals.add(name);
    env.set(name, mutable ? { kind: 'cell', value, staticType: this.typePlan.bindings?.get(token)?.[index] } : value);
  }
  need(stack, count, t) { if (stack.length < count) throw new LanguageError(`Stack underflow: need ${count}, have ${stack.length}`, t); }
  expect(value, type, t) {
    const ok = type === 'list' ? Array.isArray(value) : type === 'quotation' ? value?.kind === 'closure' : typeof value === type;
    if (!ok) throw new LanguageError(`Expected ${type}, got ${format(value)}`, t);
    return value;
  }
  *call(q, stack, t) { this.expect(q, 'quotation', t); yield* this.run(q.body, stack, new Map(q.env)); }
  *binary(name,values,token) {
    const m=this.definitions.methods?.get(name);
    const target=m && this.definitions.classes.get(m.className).instances.get(runtimeTypeKey(values[0]))?.implementations.get(name);
    if(target)yield* this.run([{...token,kind:'word',value:target}],values,new Map(this.globals));
    else yield* BUILTINS.get(name)(this,values,token);
  }
  *operand(nodes, env, missing, operator, side) {
    const local = [];
    yield* this.run(nodes, local, new Map(env), missing);
    if (local.length !== 1) throw new LanguageError(
      `${side} operand of ${operator.value} must consume 0 and produce 1 value; produced ${local.length}`, operator);
    return local[0];
  }
  *run(nodes, stack, env, missing = new Map()) {
    env.locals ??= new Set();
    missing.references ??= new Map();
    if (++this.depth > this.maxDepth) { this.depth--; throw new LanguageError('Call depth limit exceeded', nodes[0]); }
    try {
      for (const t of nodes) {
        if(t.kind==='capture') {
          const slots=t.slots;
          if(slots.length) {
            this.need(stack,Math.max(...slots.map(s=>s.index))+1,slots[0]);
            const snapshot=[...stack];
            for(const s of slots)missing.references.set(s,snapshot[snapshot.length-1-s.index]);
            const removed=[...new Set(slots.filter(s=>!s.peek).map(s=>s.index))].sort((a,b)=>a-b);
            for(const index of removed)stack.splice(snapshot.length-1-index,1);
          }
          continue;
        }
        if (++this.steps > this.maxSteps) throw new LanguageError('Execution step limit exceeded', t);
        if(t.kind==='reference')stack.push(missing.references.get(t));
        else if (t.kind === 'missing') {
          if (missing.has(t)) stack.push(missing.get(t));
          else { this.need(stack, 1, t); const value = stack.pop(); stack.push(value); }
        }
        else if (t.kind === 'bind') {
          this.need(stack, t.patterns.length, t);
          for (const name of t.names) if (env.locals.has(name)) throw new LanguageError(`Variable already declared: ${name}`, t);
          const values=stack.slice(-t.patterns.length),matched=new Map();
          if(!t.patterns.every((p,i)=>matchPattern(p,values[i],matched)))throw new LanguageError('Assignment pattern did not match',t);
          stack.splice(-t.patterns.length);
          t.names.forEach((name,index)=>this.declare(env,name,matched.get(name),t.mutable[index],t,index));
        }
        else if (t.kind === 'local-function') {
          const captured=new Map(env),value={kind:'local-function',name:t.name,body:t.body,env:captured};
          captured.set(t.name,value);
          this.declare(env,t.name,value,false,t);
        }
        else if (t.kind === 'update') {
          if (!env.has(t.name)) throw new LanguageError(`Unknown variable: ${t.name}`, t);
          const cell = env.get(t.name);
          if (cell?.kind !== 'cell') throw new LanguageError(`Cannot assign to immutable variable: ${t.name}`, t);
          const value = yield* this.operand(t.body, env, missing, t, 'Assignment');
          if (!this.journal.has(cell)) this.journal.set(cell, cell.value);
          cell.value = value;
        }
        else if (t.kind === 'scope') yield* this.run(t.body, stack, new Map(env), missing);
        else if(t.kind==='case') {
          let selected=false;
          for(const branch of t.branches) {
            const count=branch.patterns.length;
            if(stack.length<count)continue;
            const args=count?stack.slice(-count):[],matched=new Map();
            if(!branch.patterns.every((p,i)=>matchPattern(p,args[i],matched)))continue;
            const local=new Map(env);local.locals=new Set(matched.keys());
            for(const [name,value] of matched)local.set(name,value);
            const trial=count?stack.slice(0,-count):[...stack];
            if(branch.guard){yield* this.run(branch.guard,trial,new Map(local));this.need(trial,1,branch.token);if(!this.expect(trial.pop(),'boolean',branch.token))continue;}
            yield* this.run(branch.body,trial,local);stack.splice(0,stack.length,...trial);selected=true;break;
          }
          if(!selected)throw new LanguageError('No matching case branch',t);
        }
        else if (t.kind === 'binary' || t.kind==='comparison-chain') {
          const holes = missingOperands([t]).filter(hole => !missing.has(hole));
          this.need(stack, holes.length, t);
          const values = holes.length ? stack.splice(-holes.length) : [];
          const bound = new Map(missing);
          bound.references=missing.references;
          holes.forEach((hole, index) => bound.set(hole, values[index]));
          if(t.kind==='comparison-chain') {
            let left=yield* this.operand(t.operands[0],env,bound,t,'Comparison'),result=true;
            for(let i=0;i<t.operators.length;i++) {
              const op=t.operators[i],right=yield* this.operand(t.operands[i+1],env,bound,op,'Comparison'),pair=[left,right];
              yield* this.binary(op.value,pair,op);
              if(!pair[0]){result=false;break;}
              left=right;
            }
            stack.push(result);continue;
          }
          const left = yield* this.operand(t.left, env, bound, t, 'Left');
          const right = yield* this.operand(t.right, env, bound, t, 'Right');
          const operands = [left, right];
          yield* this.binary(t.value,operands,t);
          stack.push(operands[0]);
        }
        else if (t.kind === 'literal') stack.push(t.value);
        else if(t.kind==='record') {
          const holes=missingOperands([t]).filter(h=>!missing.has(h));
          this.need(stack,holes.length,t);
          const values=holes.length?stack.splice(-holes.length):[],bound=new Map(missing);
          bound.references=missing.references;holes.forEach((h,i)=>bound.set(h,values[i]));
          const fields=Object.create(null);
          for(const field of t.fields)fields[field.name]=yield* this.operand(field.body,env,bound,t,'Record field');
          stack.push({kind:'record',fields});
        }
        else if(t.kind==='field') {
          this.need(stack,1,t);const value=stack.pop();
          if(value?.kind!=='record' || !Object.hasOwn(value.fields,t.name))throw new LanguageError(`Missing record field: ${t.name}`,t);
          stack.push(value.fields[t.name]);
        }
        else if(t.kind==='tuple-index') {
          this.need(stack,1,t);const value=stack.pop();
          if(value?.kind!=='tuple' || t.index>=value.items.length)throw new LanguageError(`Tuple index out of bounds or non-tuple value: ${t.index}`,t);
          stack.push(value.items[t.index]);
        }
        else if(t.kind==='tuple') {
          const items=[];yield* this.run(t.body,items,new Map(env),missing);
          stack.push({kind:'tuple',items});
        }
        else if (t.kind === 'list') {
          const items = [];
          yield* this.run(t.body, items, new Map(env),missing);
          stack.push(items);
        }
        else if (t.kind === 'quote') stack.push({ kind: 'closure', body: t.body, env: new Map(env) });
        else if (env.has(t.value)) {
          const value=env.get(t.value);
          if(value?.kind==='local-function')yield* this.run(value.body,stack,new Map(value.env));
          else stack.push(value?.kind==='cell'?value.value:value);
        }
        else if(this.definitions.effects?.has(t.value)) {
          const op=this.definitions.effects.get(t.value);this.need(stack,op.inputCount,t);
          const args=op.inputCount?stack.splice(-op.inputCount):[];
          const returned=yield {operation:op,args,token:t};
          if(op.never)throw new LanguageError('Non-returning effect returned',t);
          stack.push(...returned);
        }
        else if (BUILTINS.has(t.value)) yield* BUILTINS.get(t.value)(this, stack, t);
        else if(this.definitions.constructors?.has(t.value)) {
          const constructor=this.definitions.constructors.get(t.value),count=constructor.fields.length;
          this.need(stack,count,t);
          stack.push({kind:'adt',typeName:constructor.typeName,constructor:t.value,fields:count ? stack.splice(-count) : []});
        }
        else if(this.definitions.methods?.has(t.value)) {
          const m=this.definitions.methods.get(t.value),c=this.definitions.classes.get(m.className);
          this.need(stack,m.inputCount,t);const v=stack[stack.length-m.inputCount+m.dispatchIndex];
          const key=runtimeTypeKey(v);
          const target=c.instances.get(key)?.implementations.get(t.value);
          if(!target)throw new LanguageError(`No instance: ${c.name} ${key||format(v)}`,t);
          yield* this.run([{...t,value:target}],stack,env);
        }
        else if (this.definitions.has(t.value)) {
          const clauses = this.definitions.get(t.value), arity = clauses[0].patterns.length;
          this.need(stack, arity, t);
          const args = arity ? stack.slice(-arity) : [];
          let bindings,selectedStack;
          let clause;
          for(const c of clauses) {
            const matched=new Map();
            if(!c.patterns.every((p,i)=>matchPattern(p,args[i],matched)))continue;
            const candidate=new Map(this.globals);candidate.locals=new Set(matched.keys());
            for(const [name,value] of matched)candidate.set(name,value);
            const trial=arity?stack.slice(0,-arity):[...stack];
            if(c.guard) {
              yield* this.run(c.guard,trial,new Map(candidate));this.need(trial,1,c.token);
              if(!this.expect(trial.pop(),'boolean',c.token))continue;
            }
            bindings=candidate;selectedStack=trial;clause=c;break;
          }
          if (!clause) throw new LanguageError(`No matching pattern for ${t.value}`, t);
          stack.splice(0,stack.length,...selectedStack);
          yield* this.run(clause.body, stack, bindings);
        } else throw new LanguageError(`Unknown word: ${t.value}`, t);
      }
    } finally { this.depth--; }
  }
}

const BUILTINS = new Map();
const define = (name, count, fn) => BUILTINS.set(name, function*(vm, s, t) { vm.need(s, count, t); const result=fn(vm,s,t);if(result?.next)yield* result; });
define('handle',2,function*(vm,s,t){
  const handlers=s.pop(),body=vm.expect(s.pop(),'quotation',t);
  if(handlers?.kind!=='record')throw new LanguageError('handle requires a handler record',t);
  for(const [name,q] of Object.entries(handlers.fields)){if(!vm.definitions.effects?.has(name))throw new LanguageError(`Unknown effect: ${name}`,t);vm.expect(q,'quotation',t);}
  const local=[],generator=vm.call(body,local,t);
  try{s.push(...(yield* vm.handle(generator,local,handlers,t)));}finally{generator.return();}
});
define('resume',1,function*(vm,s,t){
  const k=s.pop();if(k?.kind!=='continuation')throw new LanguageError('resume requires a continuation',t);
  if(k.never)throw new LanguageError('Cannot resume a non-returning effect',t);
  if(!k.active||k.used)throw new LanguageError('Continuation is expired or already resumed',t);
  vm.need(s,k.inputCount,t);const returned=k.inputCount?s.splice(-k.inputCount):[];k.used=true;
  s.push(...(yield* k.resume(returned)));
});
define('nop',0,()=>{});
for (const [name, operation] of Object.entries({ '+': (a,b)=>a+b, '-': (a,b)=>a-b, '*': (a,b)=>a*b, '/': (a,b)=>a/b, '%': (a,b)=>a%b, '^': (a,b)=>a**b, '<': (a,b)=>a<b, '>': (a,b)=>a>b, '<=': (a,b)=>a<=b, '>=': (a,b)=>a>=b })) {
  define(name, 2, (vm,s,t) => {
    const b = vm.expect(s.pop(), 'number', t), a = vm.expect(s.pop(), 'number', t);
    if (['/', '%'].includes(name) && b === 0) throw new LanguageError('Division by zero', t);
    const result = operation(a,b);
    if (typeof result === 'number' && !Number.isFinite(result)) throw new LanguageError('Non-finite numeric result', t);
    s.push(result);
  });
}
for (const name of ['==', '/=']) define(name, 2, (_vm,s) => { const b=s.pop(), a=s.pop(); s.push(name === '==' ? equal(a,b) : !equal(a,b)); });
for (const name of ['and', 'or']) define(name, 2, (vm,s,t) => { const b=vm.expect(s.pop(),'boolean',t), a=vm.expect(s.pop(),'boolean',t); s.push(name === 'and' ? a && b : a || b); });
define('not',1,(vm,s,t)=>s.push(!vm.expect(s.pop(),'boolean',t)));
define('dup',1,(_vm,s)=>s.push(s.at(-1)));
define('drop',1,(_vm,s)=>s.pop());
define('swap',2,(_vm,s)=>{ const b=s.pop(),a=s.pop(); s.push(b,a); });
define('over',2,(_vm,s)=>s.push(s.at(-2)));
define('rot',3,(_vm,s)=>{ const [a,b,c]=s.splice(-3); s.push(b,c,a); });
define('call',1,function*(vm,s,t){yield* vm.call(s.pop(),s,t);});
define('if',3,function*(vm,s,t){ const no=s.pop(),yes=s.pop(),condition=vm.expect(s.pop(),'boolean',t); vm.expect(yes,'quotation',t); vm.expect(no,'quotation',t); yield* vm.call(condition ? yes : no,s,t); });
define('when',2,function*(vm,s,t){
  const body=vm.expect(s.pop(),'quotation',t),condition=vm.expect(s.pop(),'boolean',t);
  if (condition) yield* vm.call(body,s,t);
});
define('while',2,function*(vm,s,t){
  const body=vm.expect(s.pop(),'quotation',t),condition=vm.expect(s.pop(),'quotation',t);
  for (;;) {
    if (++vm.steps > vm.maxSteps) throw new LanguageError('Execution step limit exceeded',t);
    yield* vm.call(condition,s,t);
    vm.need(s,1,t);
    if (!vm.expect(s.pop(),'boolean',t)) break;
    yield* vm.call(body,s,t);
  }
});
define('dip',2,function*(vm,s,t){ const q=s.pop(),value=s.pop(); yield* vm.call(q,s,t); s.push(value); });
define('compose',2,(vm,s,t)=>{
  const b=vm.expect(s.pop(),'quotation',t),a=vm.expect(s.pop(),'quotation',t);
  s.push({kind:'closure',env:new Map([['__a',a],['__b',b]]),body:lex('__a call __b call',t.file)});
});
define('map',2,function*(vm,s,t){
  const q=vm.expect(s.pop(),'quotation',t),list=vm.expect(s.pop(),'list',t);
  const results = [];
  for (const value of list) {
    s.push(value); yield* vm.call(q,s,t); vm.need(s,1,t); results.push(s.pop());
  }
  s.push(results);
});
define('each',2,function*(vm,s,t){
  const container=s.at(-2),target=vm.definitions.classes?.get('each')?.instances.get(runtimeTypeKey(container))?.implementations.get('each');
  if(target){yield* vm.run([{...t,kind:'word',value:target}],s,new Map(vm.globals));return;}
  const q=vm.expect(s.pop(),'quotation',t),xs=s.pop();
  if(xs?.kind==='range') {const step=xs.start<=xs.end?1:-1,count=Math.abs(xs.end-xs.start)+(xs.inclusive?1:0);for(let i=0;i<count;i++){s.push(xs.start+i*step);yield* vm.call(q,s,t);}}
  else for(const value of vm.expect(xs,'list',t)){s.push(value);yield* vm.call(q,s,t);} 
});
define('filter',2,function*(vm,s,t){
  const q=vm.expect(s.pop(),'quotation',t),list=vm.expect(s.pop(),'list',t);
  const results = [];
  for (const value of list) {
    s.push(value); yield* vm.call(q,s,t); vm.need(s,1,t);
    if (vm.expect(s.pop(),'boolean',t)) results.push(value);
  }
  s.push(results);
});
define('fold',3,function*(vm,s,t){
  const q=vm.expect(s.pop(),'quotation',t); let acc=s.pop(); const list=vm.expect(s.pop(),'list',t);
  for(const x of list) { s.push(acc,x); yield* vm.call(q,s,t); vm.need(s,1,t); acc=s.pop(); }
  s.push(acc);
});
define('cons',2,(vm,s,t)=>{ const list=vm.expect(s.pop(),'list',t),x=s.pop(); s.push([x,...list]); });
define('Push',2,(vm,s,t)=>{const x=s.pop(),xs=vm.expect(s.pop(),'list',t);s.push([...xs,x]);});
BUILTINS.set('::', BUILTINS.get('Push'));
define('concat',2,(vm,s,t)=>{ const b=vm.expect(s.pop(),'list',t),a=vm.expect(s.pop(),'list',t); s.push([...a,...b]); });
BUILTINS.set('++', BUILTINS.get('concat'));
define('length',1,(vm,s,t)=>s.push(vm.expect(s.pop(),'list',t).length));
for(const name of ['head','tail']) define(name,1,(vm,s,t)=>{ const list=vm.expect(s.pop(),'list',t); if(!list.length) throw new LanguageError(`${name}: empty list`,t); s.push(name==='head'?list[0]:list.slice(1)); });
for(const name of ['range','..','..='])define(name,2,(vm,s,t)=>{
  const end=vm.expect(s.pop(),'number',t),start=vm.expect(s.pop(),'number',t);
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||Math.abs(end-start)>100000)
    throw new LanguageError(`${name} requires safe integers at most 100000 apart`,t);
  const step=start<=end?1:-1,count=Math.abs(end-start)+(name==='..'?0:1);
  s.push(name==='range'?Array.from({length:count},(_,i)=>start+i*step):{kind:'range',start,end,inclusive:name==='..='});
});
define('print',1,(vm,s)=>{ const value=s.pop(); vm.output(typeof value==='string'?value:format(value)); });
define('show',1,(_vm,s)=>s.push(format(s.pop())));
export const builtinNames = () => [...BUILTINS.keys()].sort();
import { checkDefinitions, checkExpression, inferExpression, missingOperands } from './types.mjs';
export { StaticTypeError } from './types.mjs';

