import {emptyDict,dictGet,dictSet,dictEntries,dictHashedEntries,hashMix,hashText,scalarHash} from './hash-map.mjs';
import {bitOperation,bitOperators,bitFunctions} from './bit-values.mjs';
import {scalar,scalarType,scalarValue,numericBinary,charText} from './numeric-values.mjs';
import {withStandardFunctions} from './builtin-functions.mjs';
import {combinationNames,selections} from './combinatorics.mjs';
import {vectorOwnership} from './ownership.mjs';
import {transforms,streamTransforms,countTransform,callbackTransform} from './iteration.mjs';
import {withOption} from './builtin-option.mjs';
import {readLine} from './io-input.mjs';
import {ioEffects,effectFamilies} from './builtin-effects.mjs';
import {typeName} from './type-names.mjs';
import {runtimeTypeKey} from './operator-classes.mjs';
import {expandClasses} from './type-classes.mjs';
import { typeSyntax, patternNames } from './type-syntax.mjs';

export class LanguageError extends Error {
  constructor(message, token) {
    super(token ? `${token.file}:${token.line}:${token.col}: ${message}` : message);
    this.name = 'LanguageError';
    this.token = token;
  }
}

export function lex(source, file = '<input>', startLine=1, startCol=1) {
  const tokens = [];
  let i = 0, line = startLine, col = startCol;
  const advance = () => { const c = source[i++]; if (c === '\n') { line++; col = 1; } else col++; return c; };
  function stringToken(token) {
    advance();let raw='',chunks=[],parts=[];
    const flush=()=>{try{const value=JSON.parse('"'+raw+'"');if(/[\uD800-\uDFFF]/u.test(value))throw new Error('Invalid Unicode scalar');chunks.push(value);}catch{throw new LanguageError('Invalid string escape or literal newline',token);}raw='';};
    while(i<source.length){
      const c=advance();
      if(c==='\\'){if(i>=source.length)break;const next=advance();raw+=next==='{'||next==='}'?next:'\\'+next;continue;}
      if(c==='"'){flush();return parts.length?{...token,kind:'interpolation',chunks,parts}:{...token,kind:'literal',value:chunks[0]};}
      if(c==='}')throw new LanguageError('Unescaped } in string; use \\}',token);
      if(c==='{'){
        flush();const begin=i,exprLine=line,exprCol=col;let depth=1;
        while(i<source.length && depth){
          if(source.startsWith('--',i)){while(i<source.length&&source[i]!=='\n')advance();continue;}
          if(source[i]==='"'){stringToken({file,line,col});continue;}
          const next=advance();if(next==='{')depth++;else if(next==='}')depth--;
        }
        if(depth)throw new LanguageError('Unterminated string interpolation',token);
        parts.push(lex(source.slice(begin,i-1),file,exprLine,exprCol));continue;
      }
      raw+=c;
    }
    throw new LanguageError('Unterminated string',token);
  }
  while (i < source.length) {
    const c = source[i];
    if(source.startsWith('//',i))throw new LanguageError('// has been removed; use / for integer division',{file,line,col});
    if (/\s/.test(c)) { advance(); continue; }
    if (source.startsWith('--', i)) { while (i < source.length && source[i] !== '\n') advance(); continue; }
    const token = { file, line, col, kind: 'word', value: '' };
    if(source.startsWith(';;',i)){token.kind=';;';token.value=advance()+advance();}
    else if ('[]{}();,#'.includes(c)) { token.kind = c; token.value = advance(); }
    else if(c==="'" && /^'(?:[^'\\\r\n]|\\(?:[nrt0'"\\]|u\{[0-9a-fA-F]+\}))'/u.test(source.slice(i))){
      const match=source.slice(i).match(/^'(?:[^'\\\r\n]|\\(?:[nrt0'"\\]|u\{[0-9a-fA-F]+\}))'/u)[0];
      for(let j=0;j<match.length;j++)advance();
      const body=match.slice(1,-1).replace(/\\u\{([0-9a-fA-F]+)\}/g,(_,n)=>String.fromCodePoint(parseInt(n,16))).replace(/\\([nrt0'"\\])/g,(_,c)=>({n:'\n',r:'\r',t:'\t','0':'\0'}[c]??c));
      if([...body].length!==1||(body.codePointAt(0)>=0xd800&&body.codePointAt(0)<=0xdfff))throw new LanguageError('char literal requires one Unicode scalar',token);
      token.kind='literal';token.value=scalar('char',body);
    }
    else if (c === '"') {
      Object.assign(token,stringToken(token));
    } else {
      const rest = source.slice(i);
      const signed = c === '-' && (i === 0 || /[\s([{;,]/.test(source[i - 1]) || ['..','..=','<-'].includes(tokens.at(-1)?.value));
      const number = rest.match(signed ? /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/ : /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      const match = number || rest.match(/^(?:@[a-zA-Z_][a-zA-Z0-9_]*|\.<<\.|\.>>\.|\.&\.|\.\|\.|\?\?<-|\?\?=|\?\?|&&|\|\||\.\??(?=\[)|\.\.=|\.\.|\.\d+|\.[a-zA-Z_][a-zA-Z0-9_']*|=>|->|<-|:=|::|==|\/=|<=|>=|\+\+|\$+\d*|[~?:|!+\-*\/%^<>=]|'[a-z][a-zA-Z0-9_']*|[a-zA-Z_][a-zA-Z0-9_']*)/);
      if (!match) throw new LanguageError(`Unexpected character: ${c}`, token);
      for (let j = 0; j < match[0].length; j++) token.value += advance();
      if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(token.value)) {
        token.numericKind=/[.eE]/.test(token.value)?'float':'integer';token.numberSource=token.value;token.kind = 'literal'; token.value = Number(token.value);
        if (!Number.isFinite(token.value)) throw new LanguageError('Number must be finite', token);
      } else if (['True', 'False'].includes(token.value)) { token.kind = 'literal'; token.value = token.value === 'True'; }
    }
    token.endLine=line;token.endCol=col;tokens.push(token);
  }
  return tokens;
}

const OPERATORS = new Map([
  ['??', 0.5], ['||', 1], ['&&', 2], ['.|.', 3.2], ['.&.', 3.3], ['.<<.', 4.7], ['.>>.', 4.7], ['==', 3], ['/=', 3],
  ['<', 3], ['>', 3], ['<=', 3], ['>=', 3],
  ['..', 4], ['..=', 4], ['::', 4.5], ['+', 5], ['-', 5], ['++', 5], ['*', 6], ['/', 6], ['%', 6], ['^', 7],
]);
const isOperator = t => t?.kind === 'word' && OPERATORS.has(t.value);
const isShortCircuit=t=>['&&','||'].includes(t?.value);
const isComparison = t => t?.kind === 'word' && ['<','<=','>','>=','==','/='].includes(t.value);

let nextStackCapture=0;
function parseTokens(tokens, inherited = null, constructors = new Map()) {
  // Layout separators belong to expression bodies, not declaration headers.
  // Keep the separator on the previous line so case/local-definition layout
  // continues to use the original token positions.
  tokens=tokens.flatMap((token,index)=>{
    const previous=tokens[index-1];
    if(!previous || token.line<=(previous.endLine??previous.line) ||
      [';',';;','(','[','{'].includes(previous.kind) ||
      previous.kind==='word'&&['=','?','case','otherwise','|',':'].includes(previous.value))return [token];
    return [{...previous,kind:';',value:';',line:previous.endLine??previous.line,col:previous.endCol??previous.col,layout:true},token];
  });
  const obsolete=tokens.find(t=>t.kind==='word'&&t.value===':=');
  if(obsolete)throw new LanguageError(':= has been removed; use <- for reassignment',obsolete);
  let i = 0;
  function scope(end, opener, context = null) {
    const nodes = [];
    // Parentheses share this lexical clause. References discovered later
    // belong to its entry capture; only quotation bodies start fresh clauses.
    const startClause=t=>{context.capture={...t,kind:'capture',slots:[]};nodes.push(context.capture);};
    if(!context)context={};
    if(!context.capture)startClause(opener || tokens[i]);
    const done = () => i >= tokens.length || tokens[i].kind === end;
    const definitionAt=start=>{
      let depth=0;
      for(let k=start;k<tokens.length && tokens[k].line===tokens[start]?.line;k++) {
        const t=tokens[k];
        if(!depth && ([';',';;',','].includes(t.kind) || t.kind==='word' && ['->','<-','!'].includes(t.value) || [')',']','}'].includes(t.kind)))break;
        if(!depth&&t.kind==='word'&&t.value==='with')return -1;
        if(!depth && t.kind==='word' && t.value==='=')return k;
        if(['(','[','{'].includes(t.kind))depth++;
        if([')',']','}'].includes(t.kind))depth--;
      }
      return -1;
    };
    const updateAt=start=>{
      const target=t=>t?.kind==='word'&&identifier.test(t.value)&&!BUILTINS.has(t.value)&&!['_','mut','data','mask','with'].includes(t.value);
      let j=start;if(!target(tokens[j]))return -1;
      j++;
      if(tokens[j]?.kind==='word' && tokens[j].value.startsWith('.')) {
        while(tokens[j]?.kind==='word' && tokens[j].value.startsWith('.')) {
          const part=tokens[j++];if(['.','.?'].includes(part.value)) {if(tokens[j++]?.kind!=='[')return -1;let depth=1;while(j<tokens.length&&depth){if(tokens[j].kind==='[')depth++;if(tokens[j].kind===']')depth--;j++;}}
        }
        return ['<-','!','??<-'].includes(tokens[j]?.value)?j:-1;
      }
      while(tokens[j]?.kind===',' && target(tokens[j+1])){j+=2;}
      return tokens[j]?.kind==='word' && ['<-','!','??<-'].includes(tokens[j].value)?j:-1;
    };
    const statement = () => updateAt(i)>=0 || definitionAt(i)>=0 || tokens[i]?.kind === 'word' && (tokens[i].value === 'mut' || identifier.test(tokens[i].value) && tokens[i+1]?.kind === 'word' && ['<-', '!', '??<-'].includes(tokens[i+1].value));
    const boundary = () => done() || [';',';;',','].includes(tokens[i].kind) || statement() || (tokens[i].kind === 'word' && tokens[i].value === '->');
    function slot(t) {
      const match=t.value.match(/^(_+|\$+)(\d*)$/),depth=match[1].length-1,index=Number(match[2]||0),peek=t.value[0]==='$';
      if(!Number.isSafeInteger(index) || index>100000)throw new LanguageError('Stack reference index must be between 0 and 100000',t);
      const target=depth?context.parents?.[depth-1]:context;
      if(!target)throw new LanguageError('Stack capture exceeds enclosing block depth',t);
      if(target.capture.slots.some(s=>s.index===index && s.peek!==peek))throw new LanguageError(`Cannot mix _${index} and $${index} in the same clause`,t);
      const node={...t,kind:'reference',index,peek};
      if(depth){
        let binding=target.capture.slots.find(s=>s.index===index&&s.capturedName);
        if(!binding){node.capturedName=`@stack${nextStackCapture++}`;target.capture.slots.push(node);binding=node;}
        return {...t,kind:'word',value:binding.capturedName};
      }
      target.capture.slots.push(node);return node;
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
        if(!depth && !inner.length && t.kind==='word' && t.value==='?')branchThen=true;
        if(['(','[','{'].includes(t.kind))depth++;
        if([')',']','}'].includes(t.kind))depth--;
      });
      const branches=[];let previous=[];
      for(let j=0;j<starts.length;j++) {
        const part=block.slice(starts[j],starts[j+1]??block.length),head=part[0];
        if(head.value==='otherwise') {
          if(j!==starts.length-1 || part.length<2)throw new LanguageError('otherwise must be the last case branch and have a body',head);
          branches.push({patterns:[],body:parseTokens(part.slice(1),{parents:context.parents},constructors),token:head});continue;
        }
        let depth=0,then=-1,bar=-1;
        for(let k=1;k<part.length;k++) {
          const t=part[k];
          if(!depth && t.kind==='word' && t.value==='?'){then=k;break;}
          if(!depth && t.value==='|')bar=k;
          if(['(','[','{'].includes(t.kind))depth++;
          if([')',']','}'].includes(t.kind))depth--;
        }
        if(then<0 || then===part.length-1)throw new LanguageError('case branch requires ? and a body',head);
        const patterns=head.value==='->'?parsePatterns(part.slice(1,bar<0?then:bar),constructors):previous;
        if(head.value==='->')previous=patterns;
        const condition=head.value==='|'?part.slice(1,then):bar<0?null:part.slice(bar+1,then);
        if(condition && !condition.length)throw new LanguageError('Empty case guard',head);
        branches.push({patterns,guard:condition?[...patternStack(patterns),...parseTokens(condition,{parents:context.parents},constructors)]:null,body:[...(condition?[]:patternStack(patterns)),...parseTokens(part.slice(then+1),{parents:context.parents},constructors)],token:head});
      }
      return {...token,kind:'case',branches};
    }
    function primary() {
      if (done()) return [missing(tokens[i - 1] || opener)];
      const t = tokens[i++];
      if(t.kind==='interpolation')return [{...t,fields:t.parts.map(part=>({empty:part.length===0,body:parseTokens(part,context,constructors)}))}];
      if(t.kind==='word' && t.value.startsWith('@')) {
        if(tokens[i]?.kind==='{'){const opener=tokens[i++];return [{...t,kind:'quote',labelName:t.value.slice(1),body:scope('}',opener,{parents:[context,...context.parents||[]]})}];}
        return [{...t,kind:'label',name:t.value.slice(1),body:expression()}];
      }
      if(t.kind==='word' && t.value==='mask') {
        const operation=tokens[i++];if(operation?.kind!=='word'||operation.value.startsWith('@'))throw new LanguageError('mask requires an effect operation',t);
        let targetLabel=null;if(tokens[i]?.value?.startsWith?.('@'))targetLabel=tokens[i++].value.slice(1);
        const opener=tokens[i++];if(opener?.kind!=='{')throw new LanguageError('mask requires { body }',t);
        return [{...t,kind:'mask',operation:operation.value,targetLabel,body:scope('}',opener,{parents:context.parents})}];
      }
      if(t.kind==='word' && t.value==='with')return withBody(t);
      if(t.kind==='word' && t.value==='case')return [caseExpression(t)];
      if(t.kind==='#') {
        if(tokens[i++]?.kind!=='(')throw new LanguageError('Expected ( after #',t);
        return [{...t,kind:'tuple',body:scope(')',t,context)}];
      }
      if(t.kind==='word' && ['.','.?'].includes(t.value) && tokens[i]?.kind==='[') {
        i++;return [{...t,kind:'list-index',optional:t.value==='.?',body:scope(']',t,context)}];
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
          while(i<tokens.length){const x=tokens[i],next=i+1+(tokens[i+1]?.layout?1:0);if(!depth && (x.kind==='}' || x.kind===',' && (tokens[next]?.kind==='}' || tokens[next+1]?.value===':')))break;if(['(','[','{'].includes(x.kind))depth++;if([')',']','}'].includes(x.kind))depth--;i++;}
          fields.push({name:key.value,body:i===start?[missing(key)]:parseTokens(tokens.slice(start,i),context,constructors)});
          const end=tokens[i++];if(end?.kind==='}')break;
          if(end?.kind!==',')throw new LanguageError('Unterminated record',t);
          if(tokens[i]?.kind===';'&&tokens[i].layout)i++;
          if(tokens[i]?.kind==='}'){i++;break;}
        }
        return [{...t,kind:'record',fields}];
      }
      if(t.kind===',')throw new LanguageError('Unexpected comma',t);
      if ([')', ']', '}'].includes(t.kind)) throw new LanguageError(`Unexpected ${t.kind}`, t);
      if(t.kind==='['){
        let depth=0,dict=false;
        for(let j=i;j<tokens.length;j++){
          const x=tokens[j];if(!depth&&x.kind===']')break;
          if(!depth&&x.value===':'){dict=true;break;}
          if(['(','[','{'].includes(x.kind))depth++;if([')',']','}'].includes(x.kind))depth--;
        }
        if(dict){
          const fields=[];
          if(tokens[i]?.value===':'&&tokens[i+1]?.kind===']'){i+=2;return [{...t,kind:'dict',fields}];}
          while(i<tokens.length){
            while(tokens[i]?.layout)i++;
            const start=i;let depth=0;
            while(i<tokens.length){const x=tokens[i];if(!depth&&x.value===':')break;if(['(','[','{'].includes(x.kind))depth++;if([')',']','}'].includes(x.kind))depth--;i++;}
            if(i===start||tokens[i]?.value!==':')throw new LanguageError('Expected dictionary key: value',t);
            fields.push({body:parseTokens(tokens.slice(start,i++),context,constructors)});
            const valueStart=i;depth=0;
            while(i<tokens.length){const x=tokens[i];if(!depth&&[',',']'].includes(x.kind))break;if(['(','[','{'].includes(x.kind))depth++;if([')',']','}'].includes(x.kind))depth--;i++;}
            if(valueStart===i)throw new LanguageError('Expected dictionary value',t);
            fields.push({body:parseTokens(tokens.slice(valueStart,i),context,constructors)});
            if(tokens[i++]?.kind===']')return [{...t,kind:'dict',fields}];
            while(tokens[i]?.layout)i++;
            if(tokens[i]?.kind===']'){i++;return [{...t,kind:'dict',fields}];}
          }
          throw new LanguageError('Unterminated dictionary',t);
        }
      }
      if (['(', '[', '{'].includes(t.kind)) {
        const body = scope({ '(': ')', '[': ']', '{': '}' }[t.kind], t, t.kind!=='{'?context:{parents:[context,...context.parents||[]]});
        return [{ ...t, kind: { '(': 'scope', '[': 'list', '{': 'quote' }[t.kind], body }];
      }
      if (t.kind === 'word' && /^(?:_+|\$+)\d*$/.test(t.value)) return [slot(t)];
      if (isOperator(t)) throw new LanguageError('Unexpected binary operator', t);
      if (t.kind === 'word' && ['=', '<-', '!', '|', 'data', 'mut', ':', '->'].includes(t.value)) throw new LanguageError(`Unexpected ${t.value}`, t);
      if(t.kind==='word' && tokens[i]?.value?.startsWith?.('@') && tokens[i].line===t.endLine && tokens[i].col===t.endCol)return [{...t,targetLabel:tokens[i++].value.slice(1)}];
      return [t];
    }
    function withBody(token) {
      const braced=tokens[i]?.kind==='{';if(braced)i++;
      const updates=[];
      const nextUpdate=start=>{
        let j=start;
        while(j<tokens.length){
          const t=tokens[j];
          if(t.kind==='['||['?','.','.?'].includes(t.value)&&tokens[j+1]?.kind==='['){
            if(t.kind!=='[')j++;j++;let depth=1;
            while(j<tokens.length&&depth){if(tokens[j].kind==='[')depth++;if(tokens[j].kind===']')depth--;j++;}
          }else if(j===start&&(t.kind==='literal'&&t.numericKind==='integer'||t.kind==='word'&&identifier.test(t.value))||t.kind==='word'&&/^\.(?:[a-zA-Z_]|\d)/.test(t.value))j++;
          else break;
        }
        return j>start&&['=','!','??='].includes(tokens[j]?.value);
      };
      while(!braced||tokens[i]?.kind!=='}') {
        const path=[],fields=[];
        while(i<tokens.length) {
          const part=tokens[i];
          if(part.kind==='['||part.value==='?'&&tokens[i+1]?.kind==='['){
            const optional=part.value==='?';i+=optional?2:1;
            path.push({kind:'list-index',optional,argument:fields.length});fields.push({body:scope(']',part,context)});
          }else if(part.kind==='literal'&&!path.length&&part.numericKind==='integer'){
            i++;const index=part.value;if(!Number.isSafeInteger(index)||index<0||index>100000)throw new LanguageError('Invalid tuple index',part);path.push({kind:'tuple-index',index});
          }else if(part.kind!=='word')break;
          else if(/^\.[a-zA-Z_]/.test(part.value)){i++;path.push({kind:'field',name:part.value.slice(1)});}
          else if(/^\.\d+$/.test(part.value)){i++;const index=Number(part.value.slice(1));if(!Number.isSafeInteger(index)||index>100000)throw new LanguageError('Invalid tuple index',part);path.push({kind:'tuple-index',index});}
          else if(['.','.?'].includes(part.value) && tokens[i+1]?.kind==='['){i+=2;path.push({kind:'list-index',optional:part.value==='.?',argument:fields.length});fields.push({body:scope(']',part,context)});}
          else if(!path.length&&identifier.test(part.value)){i++;path.push({kind:'field',name:part.value});}
          else break;
        }
        const operation=tokens[i++];
        if(!path.length||!['=','!','??='].includes(operation?.value))throw new LanguageError('Expected update path = value, path ! commands, or index ??= value',operation||token);
        if(operation.value==='??='&&path.at(-1).kind!=='list-index')throw new LanguageError('??= requires an index path',operation);
        const start=i;let depth=0;
        while(i<tokens.length){
          const t=tokens[i];
          if(!depth&&(['}',')',']',';',';;'].includes(t.kind)||!braced&&t.value==='->'||t.kind===','&&nextUpdate(i+1)))break;
          if(['(','[','{'].includes(t.kind))depth++;if([')',']','}'].includes(t.kind))depth--;i++;
        }
        if(start===i)throw new LanguageError('Update requires a replacement value',tokens[i]||token);
        fields.push({body:parseTokens(tokens.slice(start,i),operation.value==='!'?{parents:context.parents}:context,constructors)});
        updates.push({...token,kind:'path-update',path,fields,updating:operation.value==='!',defaulting:operation.value==='??='});
        if(!braced)return updates;
        if([';',','].includes(tokens[i]?.kind)){i++;while(tokens[i]?.layout)i++;continue;}
        if(tokens[i]?.kind!=='}')throw new LanguageError('Unterminated with update',token);
      }
      i++;return updates;
    }
    function term() {
      const start=tokens[i],parts=primary();let previous=tokens[i-1];
      while(!done()) {
        if(tokens[i]?.value==='with'){const token=tokens[i++];parts.push(...withBody(token));previous=tokens[i-1];continue;}
        if(tokens[i].kind==='word' && /^\.(?:[a-zA-Z_]|[0-9]|\?$|$)/.test(tokens[i].value) && tokens[i].line===previous.endLine && tokens[i].col===previous.endCol){parts.push(...primary());previous=tokens[i-1];continue;}
        break;
      }
      return parts.length>1?[{...start,kind:'scope',body:parts,access:true}]:parts;
    }
    function expression(min = 0) {
      // Juxtaposition forms an operand command sequence before infix parsing.
      // Only explicit separators, declarations, and scope ends split it.
      let left;
      if(isOperator(tokens[i])) left=[missing(tokens[i])];
      else {
        left=term();
        while(!boundary() && !isOperator(tokens[i]))left.push(...term());
        if(left.length>1)left=[{...left[0],kind:'application',body:left}];
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
        if(op.value==='??'){
          if(boundary())throw new LanguageError('?? requires a fallback expression',op);
          const parent=context,capture={...op,kind:'capture',slots:[]};context={capture,parents:[parent,...parent.parents||[]]};
          let body;try{body=expression(precedence);}finally{context=parent;}
          left=[{...op,kind:'application',body:[{...op,kind:'word',value:'unwrapOrElse'},{...op,kind:'scope',body:left},{...op,kind:'quote',body:[capture,...body]}]}];continue;
        }
        const right = boundary() ? [missing(op)] : expression(precedence + (op.value==='^' ? 0 : 0.1));
        left = [{ ...op, kind: 'binary', left, right }];
      }
      return left;
    }
    while (!done()) {
      if (tokens[i].kind === ',') {i++;continue;}
      if ([';',';;'].includes(tokens[i].kind)) { startClause(tokens[i++]); continue; }
      if(tokens[i].kind==='word' && tokens[i].value==='mut')throw new LanguageError('Declare mutable variables with value -> mut name',tokens[i]);
      const eq=definitionAt(i);
      if(eq>=0) {
        const first=tokens[i],name=tokens[i],operator=tokens[eq];
        if(!name || name.kind!=='word' || !identifier.test(name.value) || ['_','mut','case','?','otherwise','end','mask','with'].includes(name.value) || BUILTINS.has(name.value) || constructors.has(name.value))throw new LanguageError('Expected a local function name before =',name||first);
        const patterns=parsePatterns(tokens.slice(i+1,eq),constructors,true);i=eq+1;
        let scan=i,scanDepth=0,explicitEnd=false;
        while(scan<tokens.length){const t=tokens[scan++];if(!scanDepth && t.kind===';;'){explicitEnd=true;break;}if(!scanDepth&&[')',']','}'].includes(t.kind))break;if(['(','[','{'].includes(t.kind))scanDepth++;if([')',']','}'].includes(t.kind))scanDepth--;}
        const start=i,multiline=tokens[i]?.line>operator.line,caseBody=tokens[i]?.kind==='word' && tokens[i]?.value==='case';let depth=0,cases=0;
        while(i<tokens.length) {
          const t=tokens[i];
          const closingCase=caseBody && t.kind==='word' && t.value==='end' && cases>0;
          if(!depth && (t.kind===';;' || [')',']','}'].includes(t.kind) || !explicitEnd && (!multiline && !caseBody && [';',','].includes(t.kind) || !closingCase && t.line>operator.line && t.col<=first.col)))break;
          if(!depth && caseBody && t.kind==='word') {
            if(t.value==='case')cases++;
            if(closingCase && --cases===0){i++;break;}
          }
          if(['(','[','{'].includes(t.kind))depth++;
          if([')',']','}'].includes(t.kind))depth--;
          i++;
        }
        const parsed=parseTokens(tokens.slice(start,i),null,constructors);
        const body=patterns.length?[{...name,kind:'case',branches:[{patterns,body:[...patternStack(patterns),...parsed],token:name}]}]:parsed;
        const previous=nodes.findLast(n=>n.kind!=='capture');
        if(previous?.kind==='local-function' && previous.name===name.value && previous.parameterized && patterns.length)
          previous.body[0].branches.push(...body[0].branches);
        else nodes.push({...name,kind:'local-function',name:name.value,body,parameterized:patterns.length>0});
        if(i<tokens.length && ![';',';;',','].includes(tokens[i].kind))startClause(tokens[i]);
        continue;
      }
      const update=updateAt(i);
      if(update>=0) {
        const access=tokens[i+1]?.value?.startsWith?.('.')?tokens.slice(i+1,update):null;
        const targets=access?[tokens[i]]:tokens.slice(i,update).filter(t=>t.kind!==','),operator=tokens[update];i=update+1;
        for(const name of targets)if(['_','mut','data','mask','with'].includes(name.value)||BUILTINS.has(name.value))throw new LanguageError('Expected a variable name',name);
        const names=targets.map(t=>t.value);
        if(new Set(names).size!==names.length)throw new LanguageError('Duplicate assignment target',targets[0]);
        // Both update operators bind less tightly than comma, for any target count.
        const start=i;let depth=0;
        while(i<tokens.length && (depth || tokens[i].kind!==end)) {
          const t=tokens[i];
          if(!depth && ([';',';;'].includes(t.kind) || t.line>operator.line))break;
          if(['(','[','{'].includes(t.kind))depth++;
          if([')',']','}'].includes(t.kind)){if(!depth)break;depth--;}
          i++;
        }
        if(start===i)throw new LanguageError('Initializer requires a value',operator);
        let rhs=tokens.slice(start,i);
        if(operator.value==='??<-'&&!access)throw new LanguageError('??<- requires an indexed mutable variable',operator);
        if(access)rhs=[targets[0],{...operator,kind:'word',value:'with'},{...operator,kind:'{',value:'{'},...access,{...operator,kind:'word',value:operator.value==='!'?'!':operator.value==='??<-'?'??=':'='},...rhs,{...operator,kind:'}',value:'}'}];
        if(operator.value==='!'&&!access) {
          const prefix=targets.flatMap((t,j)=>j?[{...operator,kind:',',value:','},t]:[t]);
          rhs.unshift(...prefix,{...operator,kind:';',value:';'});
        }
        nodes.push({...targets[0],kind:'update',name:names[0],names,body:parseTokens(rhs,operator.value==='!'&&!access?{parents:context.parents}:context,constructors)});
        if(i<tokens.length && ![';',';;',','].includes(tokens[i].kind) && tokens[i].line>operator.line)startClause(tokens[i]);
        continue;
      }
      if (tokens[i].kind === 'word' && tokens[i].value === '->') {
        const arrow=tokens[i++],parts=[],mutableNames=new Set();let depth=0;
        while(i<tokens.length && (depth || !done() && ![';',';;',','].includes(tokens[i].kind) && tokens[i].line===arrow.line)) {
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
        nodes.push({...arrow,kind:'bind',patterns,names,mutable:names.map(n=>mutableNames.has(n))},...patternStack(patterns,true));
        if(!done() && ![';',';;',','].includes(tokens[i].kind))startClause(tokens[i]);
      } else {const start=i,parsed=expression();if(i===start)throw new LanguageError('Unexpected token: '+tokens[i].value,tokens[i]);nodes.push(...parsed);}
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
      if(['record','dict','path-update','interpolation'].includes(n.kind))for(const f of n.fields)f.body=clean(f.body);
      if(n.left){n.left=clean(n.left);n.right=clean(n.right);}
      if(n.operands)n.operands=n.operands.map(clean);
      return n;
    });
  }
  return inherited?result:clean(result);
}

let nextLabel=0;
function resolveLabels(nodes,scope=new Map()) {
  for(const n of nodes){
    if(n.targetLabel){if(!scope.has(n.targetLabel))throw new LanguageError(`Unknown effect label: ${n.targetLabel}`,n);n.target=scope.get(n.targetLabel);}
    if(n.kind==='quote' && n.labelName) {
      n.blockLabel??=`@block${nextLabel++}`;
      const nested=new Map(scope);nested.set(n.labelName,n.blockLabel);resolveLabels(n.body,nested);continue;
    }
    if(n.kind==='label') {
      const root=n.body.length===1?n.body[0]:null,head=root?.kind==='application'?root.body[0]:root;
      if(head?.kind!=='word'||!['handle','while','each','vmap','vfilter','fold','reverse','sort','sortBy','maxi','mini','maxiBy','miniBy','all','any','join','toVector','nth','zip','vzip','windows','chunks','chunkBy','groupBy','fromYield',...transforms.keys()].includes(head.value))throw new LanguageError('Label requires a loop, handle, or fromYield',n);
      n.key??=`@label${nextLabel++}`;head.handlerLabel=n.key;
      const nested=new Map(scope);nested.set(n.name,n.key);resolveLabels(n.body,nested);continue;
    }
    if(n.body)resolveLabels(n.body,scope);
    if(n.left){resolveLabels(n.left,scope);resolveLabels(n.right,scope);}
    if(n.operands)n.operands.forEach(xs=>resolveLabels(xs,scope));
    if(n.fields)n.fields.forEach(f=>f.body&&resolveLabels(f.body,scope));
    if(n.branches)for(const b of n.branches){if(b.guard)resolveLabels(b.guard,scope);resolveLabels(b.body,scope);}
  }
  return nodes;
}
export const parseExpression = (source, file, constructors) => resolveLabels(parseTokens(lex(source, file),null,constructors));
const identifier = /^(?!(?:_{2,}\d*|_\d+)$)[a-zA-Z_][a-zA-Z0-9_']*$/;

function dataDeclarations(groups, definitions, globals) {
  definitions.dataTypes = new Map(definitions.dataTypes);
  definitions.constructors = new Map(definitions.constructors);
  const pending=[];
  for (const group of groups) {
    if (group[0].kind !== 'word' || group[0].value !== 'data') continue;
    const eq=group.findIndex(t=>t.kind==='word' && t.value==='=');
    const postfix=false;
    const originalName=group[postfix ? eq-1 : 1];
    const name=originalName && {...originalName,value:typeName(originalName.value)};
    if (!name || name.kind!=='word' || !/^[a-z][a-zA-Z0-9_']*$/.test(name.value) || ['data','mut'].includes(name.value) || eq<2)
      throw new LanguageError('Expected data Type parameters = Constructors',group[0]);
    if (['num','float','byte','char','bool','string','int','range','stream','vector'].includes(name.value) || definitions.dataTypes.has(name.value))
      throw new LanguageError(`Type already declared: ${name.value}`,name);
    const parameters=group.slice(postfix ? 1 : 2,postfix ? eq-1 : eq).map(t=>{
      if(t.kind!=='word' || !(postfix ? /^'[a-z][a-zA-Z0-9_']*$/ : /^'?[a-z][a-zA-Z0-9_']*$/).test(t.value) || ['mut','data'].includes(t.value))
        throw new LanguageError('Type parameters must be lowercase names',t);
      return t.value;
    });
    if(new Set(parameters).size!==parameters.length) throw new LanguageError('Duplicate type parameter',name);
    const declaration={name:name.value,parameters,token:name,postfix};
    definitions.dataTypes.set(name.value,declaration);
    pending.push({declaration,tokens:group.slice(eq+1)});
  }
  Object.assign(definitions,withOption(definitions,{skipOption:pending.some(p=>p.tokens.some(t=>['Some','None'].includes(t.value))),skipResult:pending.some(p=>p.tokens.some(t=>['Ok','Err'].includes(t.value)))}));
  {const standard=withStandardFunctions(definitions);definitions.classes=standard.classes;definitions.methods=standard.methods;for(const [name,clauses] of standard)if(!definitions.has(name))definitions.set(name,clauses);}
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

let nextPatternStack=0;
function patternStack(patterns,ephemeral=false){return patterns.flatMap(p=>p.stackMatch?[{...p,kind:'word',ephemeral}]:p.fields?patternStack(p.fields,ephemeral):[]);}
function parsePatterns(tokens, constructors,mutableParameters=false) {
  let i=0;
  function atom() {
    const t=tokens[i++];
    if(!t)throw new LanguageError('Expected a pattern after ::',tokens[i-2]);
    if(t.value==='mut' && mutableParameters) {
      const name=tokens[i++];
      if(name?.kind!=='word'||!identifier.test(name.value)||['_','mut','data'].includes(name.value)||constructors.has(name.value)||BUILTINS.has(name.value)||/^[A-Z]/.test(name.value))throw new LanguageError('mut parameter requires a variable name',name||t);
      return {...name,mutable:true};
    }
    if(t.kind==='word'&&t.value==='~')return {...t,value:`@match${nextPatternStack++}`,stackMatch:true};
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
    if(t.kind==='word' && (t.value==='Push'||constructors.has(t.value))) {
      const count=t.value==='Push'?2:constructors.get(t.value).fields.length,fields=[];
      for(let n=0;n<count;n++)fields.push(atom());
      return {...t,kind:t.value==='Push'?'push-pattern':'constructor',fields};
    }
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
      patterns.push(cons(atom()));
    }
    return patterns;
  }
  const patterns=sequence(),names=patternNames(patterns);
  if(new Set(names).size!==names.length)throw new LanguageError('Duplicate pattern variable',tokens[0]);
  return patterns;
}

function matchPattern(pattern,value,bindings,valueType) {
  if(pattern.kind==='tuple-pattern')return value?.kind==='tuple' && pattern.fields.length===value.items.length && pattern.fields.every((p,i)=>matchPattern(p,value.items[i],bindings,valueType));
  if(pattern.kind==='literal')return typeof pattern.value==='number'&&['int','float','byte'].includes(scalarType(value))?pattern.value===scalarValue(value):equal(pattern.value,value);
  if(pattern.kind==='list-pattern')return Array.isArray(value) && value.length===pattern.fields.length && pattern.fields.every((p,i)=>matchPattern(p,value[i],bindings,valueType));
  if(pattern.kind==='push-pattern')return Array.isArray(value) && value.length>0 && matchPattern(pattern.fields[0],value.slice(0,-1),bindings,valueType) && matchPattern(pattern.fields[1],value.at(-1),bindings,valueType);
  if(pattern.kind==='constructor')return value?.kind==='adt' && value.constructor===pattern.value && value.fields.length===pattern.fields.length && pattern.fields.every((p,i)=>matchPattern(p,value.fields[i],bindings,valueType));
  if(pattern.value!=='_')bindings.set(pattern.value,pattern.mutable?{kind:'cell',value,staticType:valueType?.(value)}:value);
  return true;
}

export const formatWarning=w=>`${w.file||'<input>'}:${w.line||1}:${w.col||1}: Warning [${w.code}]: ${w.message}`;
export function expressionWarnings(nodes,variables=new Set()) {
  const warnings=[],seen=new Set();
  const valueHead=(n,env)=>['literal','reference','list','tuple','quote','record'].includes(n.kind)||n.kind==='word'&&env.has(n.value)||n.kind==='scope'&&n.access||n.kind==='scope'&&n.body.filter(x=>x.kind!=='capture').length===1&&valueHead(n.body.find(x=>x.kind!=='capture'),env);
  function walk(nodes,inherited){
    const env=new Set(inherited);
    for(const n of nodes){
      if(n.kind==='application' && valueHead(n.body[0],env)){
        const h=n.body[0],key=[h.file,h.line,h.col].join(':');
        if(!seen.has(key)){seen.add(key);warnings.push({code:'W001',file:h.file,line:h.line,col:h.col,message:'A variable or literal at the head of a whitespace sequence executes last. Use commas to evaluate left to right.'});}
      }
      if(n.kind==='bind')n.names.forEach(x=>env.add(x));
      if(n.kind==='local-function'){env.delete(n.name);walk(n.body,env);continue;}
      if(n.kind==='case')for(const b of n.branches){const local=new Set([...env,...patternNames(b.patterns)]);if(b.guard)walk(b.guard,local);walk(b.body,local);}
      if(n.body)walk(n.body,env);
      if(['record','dict','path-update','interpolation'].includes(n.kind))for(const f of n.fields)walk(f.body,env);
      if(n.left){walk(n.left,env);walk(n.right,env);}
      if(n.operands)for(const o of n.operands)walk(o,env);
    }
  }
  walk(nodes,variables);return warnings;
}
export function compile(source, file = '<input>', previous = new Map(), { checkTypes = true, globals = new Map() } = {}) {
  const tokens = lex(source, file), groups = [];
  let depth = 0,afterDefinition=false,openDefinitions=0,guardHeader=false;
  for (const token of tokens) {
    if(token.kind===';;' && depth===0){
      if(openDefinitions>1){openDefinitions--;groups.at(-1).push(token);continue;}
      afterDefinition=true;openDefinitions=0;guardHeader=false;continue;
    }
    if (afterDefinition || token.col === 1 && depth === 0 && !(token.kind==='word' && ['|','end'].includes(token.value))) {groups.push([]);openDefinitions=0;guardHeader=false;}
    afterDefinition=false;
    if (!groups.length) throw new LanguageError('Top-level declarations must start in column 1', token);
    if(!depth && token.value==='|')guardHeader=true;
    if(!depth && token.value==='=' && !['data','class','instance','effect'].includes(groups.at(-1)[0]?.value)){
      if(!guardHeader||!openDefinitions)openDefinitions++;guardHeader=false;
    }
    groups.at(-1).push(token);
    if (['[', '{', '('].includes(token.kind)) depth++;
    if ([']', '}', ')'].includes(token.kind)) depth--;
  }
  const definitions = new Map(previous), local = new Set(), signatures = new Map();
  definitions.classes=previous.classes;definitions.methods=previous.methods;
  definitions.dataTypes=previous.dataTypes;
  definitions.constructors=previous.constructors;
  dataDeclarations(groups,definitions,globals);
  Object.assign(definitions,withOption(definitions));
  {const standard=withStandardFunctions(definitions);definitions.classes=standard.classes;definitions.methods=standard.methods;for(const [name,clauses] of standard)if(!definitions.has(name))definitions.set(name,clauses);}
  definitions.effects=ioEffects(previous.effects);
  const families=effectFamilies(definitions.effects);
  for(let group of groups)if(group[0].value==='effect') {
    if(!group.some(t=>t.value===':')&&group[2]?.kind==='('){const end=group.findIndex(t=>t.kind===')');if(end>2)group=[...group.slice(0,end+1),{...group[end],value:':'},...group.slice(end+1)];}
    const token=group[0],where=group.findIndex(t=>t.line===token.line && t.value==='where');
    const grouped=where>=0,colonIndex=group.findIndex(t=>t.value===':'),name=group[1],parameterTokens=group.slice(2,grouped?where:colonIndex).map(t=>t.value),rowParameters=parameterTokens.filter((p,i)=>parameterTokens[i-1]==='..'),parameters=parameterTokens.filter(p=>!['(',')','..'].includes(p));
    if((grouped?where<2:colonIndex<2) || !name || !/^[a-z][A-Za-z0-9_']*$/.test(name.value) || parameters.some(p=>!/^'[a-z][A-Za-z0-9_']*$/.test(p)))throw new LanguageError("Expected effect name 'a : signature or effect name 'a where",token);
    if(new Set(parameters).size!==parameters.length)throw new LanguageError('Duplicate effect type parameter',token);
    if(['yield','break'].includes(name.value) && definitions.effects.get(name.value)?.builtin){definitions.effects.delete(name.value);families.delete(name.value);}
    if(families.has(name.value)||definitions.effects.has(name.value)||definitions.has(name.value)||BUILTINS.has(name.value)||definitions.constructors.has(name.value)||globals.has(name.value))throw new LanguageError(`Effect name already used: ${name.value}`,name);
    const members=[];
    if(grouped){
      const body=group.slice(where+1),indent=body[0]?.col;let depth=0;
      if(!body.length||body[0].line===token.line||indent<=token.col)throw new LanguageError('Effect group requires indented operations',token);
      for(const t of body){
        if(!depth && t.col===indent && (!members.length||t.line>members.at(-1).at(-1).line))members.push([]);
        if(!members.length||t.col<indent)throw new LanguageError('Invalid effect operation indentation',t);
        members.at(-1).push(t);
        if(['(','[','{'].includes(t.kind))depth++;if([')',']','}'].includes(t.kind))depth--;
      }
    }else members.push([name,group[colonIndex],...group.slice(colonIndex+1)]);
    const used=new Set(),ops=[];
    for(const member of members){
      const opName=member[0];
      if(member[1]?.value!==':'||!opName||!/^[a-z][A-Za-z0-9_']*$/.test(opName.value))throw new LanguageError('Effect operation requires name : signature',opName||token);
      if(definitions.effects.has(opName.value)||definitions.has(opName.value)||BUILTINS.has(opName.value)||definitions.constructors.has(opName.value)||globals.has(opName.value)||families.has(opName.value))throw new LanguageError(`Effect operation name already used: ${opName.value}`,opName);
      const parser=typeSyntax(member.slice(2).map(t=>t.value),definitions.dataTypes,new Set(parameters),m=>{throw new LanguageError(m,opName);});
      const syntax=parser.effect();if(opName.value==='break'&&(!syntax.never||parameters.length!==1||rowParameters.length!==1||syntax.input.length!==1||syntax.input[0].tag!=='stack-row'||syntax.input[0].name!==rowParameters[0]))throw new LanguageError('break requires one stack row parameter and consumes that row without returning',opName);if(!parser.done())throw new LanguageError('Unexpected effect signature token',opName);
      const visit=t=>{if(t&&typeof t==='object'){if(t.tag==='param'||t.tag==='stack-row')used.add(t.name);if(typeof t.tail==='string')used.add(t.tail);Object.values(t).forEach(v=>Array.isArray(v)?v.forEach(visit):visit(v));}};visit(syntax);
      const operation={name:opName.value,parameters,rowParameters,syntax,inputCount:syntax.input.filter(t=>t.tag!=='stack-row').length,outputCount:syntax.output.length,never:!!syntax.never,token:opName,...(grouped?{group:name.value,grouped:true}:{})};
      definitions.effects.set(opName.value,operation);ops.push(operation);
    }
    for(const p of parameters)if(!used.has(p))throw new LanguageError(`Unused effect type parameter: ${p}`,token);
    families.set(name.value,{name:name.value,parameters,operations:ops,grouped});
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
    const withAt=outer.findIndex(t=>t.value==='with'),headerTokens=withAt<0?outer:outer.slice(0,withAt);
    if (outer.some(t => t.kind === 'word' && t.value === '->') && !headerTokens.some(t => t.kind === 'word' && (t.value === '=' || t.value === ':'))) {
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
    if (header===undefined || header<1) throw new LanguageError('Expected name [patterns] = body or name | condition = body', first);
    const name = group[0];
    if (!identifier.test(name.value) || name.kind !== 'word' || ['_', 'mut', 'data', 'mask', 'with'].includes(name.value)) throw new LanguageError('Expected a function name before =', name);
    if(definitions.effects.has(name.value))throw new LanguageError(`Cannot redefine effect: ${name.value}`,name);
    if(definitions.methods.has(name.value))throw new LanguageError(`Cannot redefine class method: ${name.value}`,name);
    if(name.value.startsWith('__tc_') && !name.internal)throw new LanguageError('Reserved instance implementation name',name);
    if (BUILTINS.has(name.value)) throw new LanguageError('Cannot redefine a built-in word', name);
    if(definitions.constructors.has(name.value))throw new LanguageError(`Cannot redefine constructor: ${name.value}`,name);
    const patterns = parsePatterns(group.slice(1, header),definitions.constructors,true);
    if (!local.has(name.value)) { definitions.set(name.value, []); local.add(name.value); }
    const clauses = definitions.get(name.value);
    if (clauses.length && clauses[0].patterns.length !== patterns.length) throw new LanguageError('All clauses must have the same arity', name);
    if(group[header].value==='=') {
      clauses.push({patterns,body:[...patternStack(patterns),...parseTokens(group.slice(header+1),null,definitions.constructors)],token:name});
    } else {
      const bars=separators.filter(i=>group[i].value==='|' && (group[i].line===group[header].line || group[i].col===group[header].col));
      for(let j=0;j<bars.length;j++) {
        const start=bars[j],end=bars[j+1]??group.length;
        const eq=separators.find(i=>i>start && i<end && group[i].value==='=');
        if(eq===undefined || eq===start+1 || eq+1===end)throw new LanguageError('Guard requires a condition and = body',group[start]);
        const condition=group.slice(start+1,eq);
        const guard=condition.length===1 && condition[0].value==='otherwise'
          ? [{...condition[0],kind:'literal',value:true}] : parseTokens(condition,null,definitions.constructors);
        clauses.push({patterns,guard:[...patternStack(patterns),...guard],body:parseTokens(group.slice(eq+1,end),null,definitions.constructors),token:name});
      }
    }
  }
  for(const c of definitions.classes.values())for(const inst of c.instances.values())for(const [n,s] of inst.signatures||[])signatures.set(n,s);
  for (const name of signatures.keys()) if (!definitions.has(name)) throw new LanguageError(`Signature without definition: ${name}`);
  for (const [name,signature] of signatures) {
    const clauses = [...definitions.get(name)]; clauses.signature = signature; definitions.set(name,clauses);
  }
  for(const clauses of definitions.values())for(const clause of clauses){resolveLabels(clause.body);if(clause.guard)resolveLabels(clause.guard);}
  resolveLabels(definitions.initializers);
  const types = checkTypes ? checkDefinitions(definitions,globals) : new Map();
  const variables=new Set(globals.keys()),warnings=expressionWarnings(definitions.initializers,variables);
  for(const n of definitions.initializers)if(n.kind==='bind')n.names.forEach(x=>variables.add(x));
  for(const [name,clauses] of definitions)if(local.has(name))for(const clause of clauses){const env=new Set([...variables,...patternNames(clause.patterns)]);warnings.push(...expressionWarnings([...(clause.guard||[]),...clause.body],env));}
  return { definitions, signatures, types, warnings };
}

export function format(value) {
  if(value?.kind==='scalar')return value.type==='char'?charText(value.value):String(value.value);
  if(value?.kind==='continuation')return '<continuation>';
  if(value?.kind==='stream')return '<stream>';
  if(value?.kind==='range')return `(${value.start} ${value.inclusive?'..=':'..'} ${value.end})`;
  if(value?.kind==='tuple')return `#(${value.items.map(format).join(' ')})`;
  if(value?.kind==='dict')return value.entries.length?'['+value.entries.map(([k,v])=>format(k)+': '+format(v)).join(', ')+']':'[:]';
  if(value?.kind==='record')return Object.keys(value.fields).length ? `{${Object.keys(value.fields).sort().map(k=>`${k}: ${format(value.fields[k])}`).join(', ')}}` : '{:}';
  if (Array.isArray(value)) return `[${value.map(format).join(', ')}]`;
  if (value?.kind === 'closure') return '{ ... }';
  if (value?.kind === 'adt') return value.fields.length ? `(${value.constructor} ${value.fields.map(format).join(' ')})` : value.constructor;
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return String(value);
}
function equal(a, b) {
  if(a?.kind==='scalar'||b?.kind==='scalar')return a?.kind==='scalar'&&b?.kind==='scalar'&&a.type===b.type&&a.value===b.value;
  if(a?.kind==='range' && b?.kind==='range')return a.start===b.start && a.end===b.end && a.inclusive===b.inclusive;
  if(a?.kind==='dict'&&b?.kind==='dict'){if(a.size!==b.size)return false;for(const [k,v,h] of dictHashedEntries(a)){const p=dictGet(b,k,h,equal);if(!p||!equal(v,p.value))return false;}return true;}
  if(a?.kind==='tuple' && b?.kind==='tuple')return equal(a.items,b.items);
  if(a?.kind==='record' && b?.kind==='record')return Object.keys(a.fields).length===Object.keys(b.fields).length && Object.keys(a.fields).every(k=>Object.hasOwn(b.fields,k) && equal(a.fields[k],b.fields[k]));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  if(a?.kind==='adt' && b?.kind==='adt')return a.typeName===b.typeName && a.constructor===b.constructor && equal(a.fields,b.fields);
  return a === b;
}

export class VM {
  constructor({ definitions = new Map(), output = console.log, input = readLine, maxSteps = 100000, maxDepth = 200, checkTypes = true, optimizeVectors = true, warnings = [], warning = w=>console.warn(formatWarning(w)) } = {}) {
    this.definitions = withStandardFunctions(withOption(definitions)); this.definitions.effects=ioEffects(this.definitions.effects); this.output = output; this.input = input; this.maxSteps = maxSteps; this.maxDepth = maxDepth;
    this.globals = new Map();
    this.optimizeVectors=optimizeVectors;this.checkTypes = checkTypes;this.warning=warning;this.warnings=[...warnings];for(const w of warnings)this.warning(w);
  }
  execute(nodes, stack = []) {
    const pending = this.initialized === this.definitions ? [] : this.definitions.initializers || [];
    this.typePlan = {};
    this.vectorReuse=this.optimizeVectors?vectorOwnership(this.definitions,nodes):new WeakSet();
    this.vectorUpdates={inPlace:0,copied:0};
    if (this.checkTypes) checkExpression(nodes,this.definitions,this.globals,stack,this.typePlan, !pending.length);
    const warnings=expressionWarnings(nodes,new Set([...this.globals].filter(([,v])=>v?.kind!=='local-function').map(([n])=>n)));this.warnings=warnings;for(const w of warnings)this.warning(w);
    this.steps = 0; this.depth = 0;
    const previous = this.globals;
    this.globals = new Map(previous);
    this.globals.locals = new Set(previous.keys());
    this.journal = new Map();
    try {
      this.finish(this.run(pending, [], this.globals,new Map(),this.typePlan.dispatch?.trace));
      this.finish(this.run(nodes, stack, this.globals, new Map(), this.typePlan.dispatch?.trace));
      for (const [cell, type] of this.typePlan.cells || []) cell.staticType = type;
      this.initialized = this.definitions;
      return stack;
    } catch (error) {
      for (const [cell, value] of this.journal) cell.value = value;
      this.globals = previous; throw error;
    }
  }
  async executeAsync(nodes, stack = []) {
    const pending = this.initialized === this.definitions ? [] : this.definitions.initializers || [];
    this.typePlan = {};
    this.vectorReuse=this.optimizeVectors?vectorOwnership(this.definitions,nodes):new WeakSet();
    this.vectorUpdates={inPlace:0,copied:0};
    if (this.checkTypes) checkExpression(nodes,this.definitions,this.globals,stack,this.typePlan, !pending.length);
    const warnings=expressionWarnings(nodes,new Set([...this.globals].filter(([,v])=>v?.kind!=='local-function').map(([n])=>n)));this.warnings=warnings;for(const w of warnings)this.warning(w);
    this.steps = 0; this.depth = 0;
    const previous = this.globals;
    this.globals = new Map(previous);
    this.globals.locals = new Set(previous.keys());
    this.journal = new Map();
    try {
      await this.finishAsync(this.run(pending, [], this.globals,new Map(),this.typePlan.dispatch?.trace));
      await this.finishAsync(this.run(nodes, stack, this.globals, new Map(), this.typePlan.dispatch?.trace));
      for (const [cell, type] of this.typePlan.cells || []) cell.staticType = type;
      this.initialized = this.definitions;
      return stack;
    } catch (error) {
      for (const [cell, value] of this.journal) cell.value = value;
      this.globals = previous; throw error;
    }
  }
  hostEffect(request) {
    if(request.target||request.skip)throw new LanguageError(`Unhandled routed effect: ${request.operation.name}`,request.token);
    if(request.operation.name==='put'){this.output(this.expect(request.args[0],'string',request.token));return [];}
    if(request.operation.name==='read')return this.input();
    if(request.operation.name==='exn')throw new LanguageError(`Exception: ${request.args[0]}`,request.token);
    throw new LanguageError(`Unhandled effect: ${request.operation.name}`,request.token);
  }
  finish(generator) {
    try {
      let result=generator.next();
      while(!result.done){const request=result.value,value=this.hostEffect(request);
        if(value?.then)throw new LanguageError('Asynchronous input requires executeAsync',request.token);
        result=generator.next(request.operation.name==='read'?[this.expect(value,'string',request.token)]:[]);
      }
    } finally {generator.return();}
  }
  async finishAsync(generator) {
    try {
      let result=generator.next();
      while(!result.done){const request=result.value,value=await this.hostEffect(request);
        result=generator.next(request.operation.name==='read'?[this.expect(value,'string',request.token)]:[]);
      }
    } finally {generator.return();}
  }
  labelTarget(holder,t) {if(!holder?.current)throw new LanguageError('Effect label is outside its handler lifetime',t);return holder.current;}
  accept(request,target) {if(request.bypassUntil){if(request.bypassUntil!==target)return false;delete request.bypassUntil;}if(request.target)return request.target===target;if(request.skip){request.skip--;return false;}return true;}
  *loop(iterator,t) {
    const target={},previous=t.label?.current;t.loopTarget=target;if(t.label)t.label.current=target;
    try {let result=iterator.next();while(!result.done){const request=result.value;if((request.operation.name==='cancel'||request.operation.name==='break'&&!t.cancelOnly) && this.accept(request,target)){if(request.operation.name==='break')t.breakValues=request.args;return false;}
      const returned=yield request;result=iterator.next(returned);
    }return true;}finally{iterator.return();if(t.label)t.label.current=previous;}
  }
  *handle(generator,values,handlers,token,initial,target=null) {
    let result=generator.next(initial);
    while(!result.done) {
      const request=result.value,handler=handlers.fields[request.operation.name];
      if(!handler || !this.accept(request,target)){const returned=yield request;result=generator.next(returned);continue;}
      const vm=this,k={kind:'continuation',used:false,active:true,never:request.operation.never,inputCount:request.outputCount??request.operation.outputCount,
        *resume(returned){return yield* vm.handle(generator,values,handlers,token,returned,target);}};
      const local=[...request.args,k];
      try {yield* this.call(handler,local,{...request.token,quotations:token.quotations});return local;}
      finally {k.active=false;generator.return();}
    }
    return values;
  }
  evaluate(source, stack = [], file = '<eval>') { return this.execute(parseExpression(source, file,this.definitions.constructors), stack); }
  evaluateAsync(source, stack = [], file = '<eval>') { return this.executeAsync(parseExpression(source,file,this.definitions.constructors),stack); }
  infer(source, file = '<type>') {const nodes=parseExpression(source,file,this.definitions.constructors);this.warnings=expressionWarnings(nodes,new Set([...this.globals].filter(([,v])=>v?.kind!=='local-function').map(([n])=>n)));for(const w of this.warnings)this.warning(w);return inferExpression(nodes,this.definitions,this.globals, this.initialized === this.definitions); }
  declare(env, name, value, mutable, token, index = 0) {
    if(this.definitions.constructors?.has(name))throw new LanguageError(`Cannot shadow constructor: ${name}`,token);
    if (env.locals.has(name)) throw new LanguageError(`Variable already declared: ${name}`, token);
    if (env === this.globals && this.definitions.has(name)) throw new LanguageError(`Global variable conflicts with function: ${name}`, token);
    env.locals.add(name);
    env.set(name, mutable ? { kind: 'cell', value, staticType: this.typePlan.bindings?.get(token)?.[index] } : value);
  }
  need(stack, count, t) { if (stack.length < count) throw new LanguageError(`Stack underflow: need ${count}, have ${stack.length}`, t); }
  expect(value, type, t) {
    if(type==='number'&&value?.kind==='scalar'&&value.type!=='char')return value.value;
    const ok = type === 'list' ? Array.isArray(value) : type === 'quotation' ? value?.kind === 'closure' : typeof value === type;
    if (!ok) throw new LanguageError(`Expected ${type==='list'?'vector':type}, got ${format(value)}`, t);
    return value;
  }
  *call(q, stack, t) {
    this.expect(q,'quotation',t);
    if(q.native){yield* q.native(stack);return;}
    const trace=t.quotations?.get(q)?.trace;
    if(trace)this.typePlan.dispatch?.validate(q.body,trace);
    const env=new Map(q.env);
    if(!q.blockLabel){yield* this.run(q.body,stack,env,new Map(),trace);return;}
    // This boundary denotes the execution context, independently of which
    // combinator invoked the block. Inner handlers cannot intercept its routes.
    const target={},holder={kind:'effect-label',key:q.blockLabel,current:target};env.set(q.blockLabel,holder);
    const iterator=this.run(q.body,stack,env,new Map(),trace);
    try {let result=iterator.next();while(!result.done){const request=result.value;if(request.target===target)delete request.target;const returned=yield request;result=iterator.next(returned);}}
    finally {iterator.return();holder.current=null;}

  }
  *hashValue(value,t){
    const target=this.definitions.classes?.get('hash')?.instances.get(runtimeTypeKey(value))?.implementations.get('hash');
    if(target){const local=[value];yield* this.run([{...t,kind:'word',value:target}],local,new Map(this.globals));return scalarHash(scalarValue(local[0]),'int');}
    const type=scalarType(value)||(typeof value==='boolean'?'bool':typeof value==='string'?'string':null),simple=scalarHash(scalarValue(value),type);
    if(simple!==null)return simple;
    if(value?.kind==='dict'){let sum=0;for(const [k,v] of dictEntries(value))sum=(sum+hashMix(yield* this.hashValue(k,t),yield* this.hashValue(v,t)))>>>0;return hashMix(hashMix(hashText('dict'),value.size),sum);}
    let tag,items;
    if(Array.isArray(value)){tag='vector';items=value;}
    else if(value?.kind==='tuple'){tag='tuple';items=value.items;}
    else if(value?.kind==='record'){let h=hashText('record');for(const key of Object.keys(value.fields).sort()){h=hashMix(h,hashText(key));h=hashMix(h,yield* this.hashValue(value.fields[key],t));}return h;}
    else if(value?.kind==='range'){tag='range';items=[value.start,value.end,value.inclusive];}
    else if(value?.kind==='adt'&&['option','result'].includes(value.typeName)){tag=value.typeName+':'+value.constructor;items=value.fields;}
    else throw new LanguageError('No hash instance for value',t);
    let h=hashText(tag);for(const item of items)h=hashMix(h,yield* this.hashValue(item,t));return h;
  }
  *walk(xs,consume,t) {
    const vm=this,callback=consume,consumerTarget=t.loopTarget;
    consume=function*(value){const iterator=callback(value);try{let result=iterator.next();while(!result.done){const request=result.value;if(['cancel','break'].includes(request.operation.name)&&!request.target&&!request.bypassUntil&&consumerTarget)request.bypassUntil=request.operation.name==='break'&&t.cancelOnly?t.breakTarget:consumerTarget;const returned=yield request;result=iterator.next(returned);}}finally{iterator.return();}};
    if(xs?.kind==='stream'&&xs.mode==='dict-values'){for(const [,value] of dictEntries(xs.source))yield* consume(value);return;}
    if(xs?.kind==='stream'&&xs.mode==='snapshot'){for(const item of xs.items)yield* consume(item);return;}
    if(xs?.kind==='stream') {
      if(xs.mode==='partition'){
        const iteration={...t,label:xs.label,cancelOnly:false,breakTarget:t.loopTarget};
        let pending=[],lastKey,hasKey=false;
        const emit=function*(items){yield* consume(xs.operation==='chunkBy'?{kind:'stream',mode:'snapshot',items}:items);};
        const completed=yield* vm.loop(vm.walk(xs.source,function*(item){
          if(xs.operation==='chunkBy'){
            const local=[item];yield* vm.call(xs.block,local,t);vm.need(local,1,t);const key=local.pop();
            if(hasKey&&!equal(lastKey,key)){const ready=pending;pending=[];yield* emit(ready);}
            pending.push(item);lastKey=key;hasKey=true;
          }else{
            pending.push(item);
            if(pending.length===xs.count){const ready=[...pending];pending=xs.operation==='windows'?pending.slice(1):[];yield* emit(ready);}
          }
        },iteration),iteration);
        if(completed&&pending.length&&xs.operation!=='windows')yield* emit([...pending]);
        return;
      }
      if(xs.mode==='zip'){
        const marker={},iteration={...t,label:xs.label,cancelOnly:!!xs.eager,breakTarget:t.loopTarget};
        const source=function*(value){yield* vm.walk(value,function*(item){yield {operation:{name:"__zip_item"},marker,item};},iteration);};
        const left=source(xs.left),right=source(xs.right);
        const next=function*(iterator){let step=iterator.next();while(!step.done&&step.value.marker!==marker){const returned=yield step.value;step=iterator.next(returned);}return step;};
        try{yield* vm.loop((function*(){while(true){const a=yield* next(left);if(a.done)return;const b=yield* next(right);if(b.done)return;yield* consume({kind:'tuple',items:[a.value.item,b.value.item]});}})(),iteration);}finally{left.return();right.return();}return;
      }
      if(xs.mode==='combinatorial') {
        const items=[],right=[];yield* this.loop(this.walk(xs.source,function*(v){items.push(v);},t),{...t});
        if(xs.operation==='cartesianProduct'){
          yield* this.loop(this.walk(xs.right,function*(v){right.push(v);},t),{...t});
          for(const a of items)for(const b of right){if(++this.steps>this.maxSteps)throw new LanguageError('Execution step limit exceeded',t);yield* consume({kind:'tuple',items:[a,b]});}
        } else {
          const counts=xs.operation==='powerset'?Array.from({length:items.length+1},(_,i)=>i):[xs.count];
          for(const k of counts)for(const values of selections(items,k,xs.operation==='powerset'?'combinations':xs.operation,()=>{if(++this.steps>this.maxSteps)throw new LanguageError('Execution step limit exceeded',t);})){
            if(++this.steps>this.maxSteps)throw new LanguageError('Execution step limit exceeded',t);yield* consume(values);
          }
        }
        return;
      }
      if(xs.mode==='split') {
        if(xs.separator===''){for(const char of xs.source)yield* consume(char);}
        else {let start=0;while(true){const end=xs.source.indexOf(xs.separator,start);if(end<0){yield* consume(xs.source.slice(start));break;}yield* consume(xs.source.slice(start,end));start=end+xs.separator.length;}}
        return;
      }
      if(xs.mode==='fromYield') {
        const iterator=this.call(xs.block,[],t),target={},previous=xs.label?.current;if(xs.label)xs.label.current=target;
        try {let result=iterator.next();while(!result.done){const request=result.value;
          if(request.operation.name==='yield' && this.accept(request,target)){yield* consume(request.args[0]);result=iterator.next([]);}
          else {const returned=yield request;result=iterator.next(returned);}
        }}finally{iterator.return();if(xs.label)xs.label.current=previous;}
      } else {
        const mode=xs.mode,iteration={...t,label:xs.eager?undefined:xs.label,cancelOnly:!!xs.eager,breakTarget:t.loopTarget},stop={};let remaining=xs.count,skipping=true;
        if(mode==='take' && remaining===0)return;
        const iterator=this.walk(xs.source,function*(value){
          if(mode==='skip' && remaining>0){remaining--;return;}
          if(mode==='flatten'){yield* vm.walk(value,consume,iteration);return;}
          if(mode==='take'||mode==='skip'){yield* consume(value);if(mode==='take' && --remaining===0)throw stop;return;}
          if(mode==='skipWhile'&&!skipping){yield* consume(value);return;}
          const local=[value];yield* vm.call(xs.block,local,t);vm.need(local,1,t);const result=local.pop();
          if(mode==='map')yield* consume(result);
          else if(mode==='flatMap')yield* vm.walk(result,consume,iteration);
          else {const flag=vm.expect(result,'boolean',t);
            if(mode==='filter'){if(flag)yield* consume(value);}
            else if(mode==='takeWhile'){if(!flag)throw stop;yield* consume(value);}
            else if(!flag){skipping=false;yield* consume(value);}
          }
        },iteration);
        try {yield* this.loop(iterator,iteration);}catch(error){if(error!==stop)throw error;}
      }
      return;
    }
    if(xs?.kind==='dict'){for(const [key,value] of dictEntries(xs))yield* consume({kind:'tuple',items:[key,value]});return;}
    const target=this.definitions.classes?.get('streem')?.instances.get(runtimeTypeKey(xs))?.implementations.get('each');
    if(target){const visitor={kind:'closure',native:function*(local){const iterator=consume(local.pop());try{let result=iterator.next();while(!result.done){const request=result.value;if(['cancel','break'].includes(request.operation.name)&&!request.target&&!request.bypassUntil&&t.loopTarget)request.bypassUntil=t.loopTarget;const returned=yield request;result=iterator.next(returned);}}finally{iterator.return();}}};yield* this.run([{...t,kind:'word',value:target}],[xs,visitor],new Map(this.globals));return;}
    if(xs?.kind==='range'){const step=xs.start<=xs.end?1:-1,count=Math.abs(xs.end-xs.start)+(xs.inclusive?1:0);for(let i=0;i<count;i++){this.steps++;if(this.steps>this.maxSteps)throw new LanguageError('Execution step limit exceeded',t);yield* consume(xs.start+i*step);}}
    else for(const value of this.expect(xs,'list',t))yield* consume(value);
  }
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
  *run(nodes, stack, env, missing = new Map(), trace = this.currentTrace) {
    const previousTrace=this.currentTrace;
    env.locals ??= new Set();
    missing.references ??= new Map();
    if (++this.depth > this.maxDepth) { this.depth--; throw new LanguageError('Call depth limit exceeded', nodes[0]); }
    try {
      for (const t of nodes) {
        this.currentTrace=trace;const dispatch=this.typePlan.dispatch;let info=trace?.get(t);
        if(dispatch&&!info&&t.kind==='word'&&(this.definitions.has(t.value)||this.definitions.methods?.has(t.value)))info=dispatch.runtimeCall(t,stack);
        if(dispatch&&info)dispatch.observe(stack,info.input);
        if(t.kind==='capture') {
          const slots=t.slots;
          if(slots.length) {
            this.need(stack,Math.max(...slots.map(s=>s.index))+1,slots[0]);
            const snapshot=[...stack];
            for(const s of slots){const value=snapshot[snapshot.length-1-s.index];missing.references.set(s,value);if(s.capturedName)env.set(s.capturedName,value);}
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
          if(!t.patterns.every((p,i)=>matchPattern(p,values[i],matched,this.typePlan.valueType)))throw new LanguageError('Assignment pattern did not match',t);
          stack.splice(-t.patterns.length);
          t.names.forEach((name,index)=>this.declare(env,name,matched.get(name),t.mutable[index],t,index));
        }
        else if (t.kind === 'local-function') {
          const captured=new Map(env),value={kind:'local-function',name:t.name,body:t.body,env:captured};
          captured.set(t.name,value);
          this.declare(env,t.name,value,false,t);
        }
        else if (t.kind === 'update') {
          const names=t.names||[t.name],cells=names.map(name=>{
            if(!env.has(name))throw new LanguageError(`Unknown variable: ${name}`,t);
            const cell=env.get(name);if(cell?.kind!=='cell')throw new LanguageError(`Cannot assign to immutable variable: ${name}`,t);return cell;
          });
          const values=[];yield* this.run(t.body,values,new Map(env),missing);
          if(values.length!==names.length)throw new LanguageError(`Assignment requires ${names.length} value(s); produced ${values.length}`,t);
          cells.forEach((cell,i)=>{if(!this.journal.has(cell))this.journal.set(cell,cell.value);cell.value=values[i];});
        }
        else if (t.kind === 'scope') yield* this.run(t.body, stack, new Map(env), missing);
        else if(t.kind==='case') {
          let selected=false;
          for(const branch of t.branches) {
            const count=branch.patterns.length;
            if(stack.length<count)continue;
            const args=count?stack.slice(-count):[],matched=new Map();
            if(!branch.patterns.every((p,i)=>matchPattern(p,args[i],matched,this.typePlan.valueType)))continue;
            const local=new Map(env);local.locals=new Set(matched.keys());
            for(const [name,value] of matched)local.set(name,value);
            const trial=count?stack.slice(0,-count):[...stack];
            if(branch.guard){yield* this.run(branch.guard,trial,new Map(local));this.need(trial,1,branch.token);if(!this.expect(trial.pop(),'boolean',branch.token))continue;}
            yield* this.run(branch.body,trial,local);stack.splice(0,stack.length,...trial);selected=true;break;
          }
          if(!selected)throw new LanguageError('No matching case branch',t);
        }
        else if(t.kind==='label') {const local=new Map(env);local.set(t.key,{kind:'effect-label',key:t.key,current:null});yield* this.run(t.body,stack,local,missing);}
        else if(t.kind==='mask') {
          const iterator=this.run(t.body,stack,new Map(env),missing);try{let result=iterator.next();while(!result.done){const request=result.value;
            if(request.operation.name===t.operation && !request.target){if(t.target)request.target=this.labelTarget(env.get(t.target),t);else request.skip=(request.skip||0)+1;}
            const returned=yield request;result=iterator.next(returned);
          }}finally{iterator.return();}
        }
        else if(t.kind==='application') {
          const [head,...args]=t.body;
          yield* this.run([...args,head],stack,env,missing);
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
          if(isShortCircuit(t)){
            let flag;if(t.value==='&&')flag=this.expect(left,'boolean',t);else {const probe=[left];yield* this.run([{...t,kind:'word',value:'hasValue'}],probe,new Map(this.globals));flag=this.expect(probe[0],'boolean',t);}
            if(t.value==='&&'?flag:!flag){const right=yield* this.operand(t.right,env,bound,t,'Right');if(t.value==='&&')stack.push(this.expect(right,'boolean',t));else{const pair=[left,right];yield* this.binary('||',pair,t);stack.push(pair[0]);}}
            else stack.push(left);continue;
          }
          const right = yield* this.operand(t.right, env, bound, t, 'Right');
          const operands = [left, right];
          yield* this.binary(t.value,operands,t);
          stack.push(operands[0]);
        }
        else if(t.kind==='literal'){
          const literal=info&&typeof t.value==='number'&&t.numericKind!=='float'&&Number.isInteger(t.value)?typeIR.integerLiteralInfo(this.definitions,t,typeIR.prune(info.output).item):null;
          if(literal?.conversion){const local=[t.value];yield* BUILTINS.get('fromInt')(this,local,{...t,value:'fromInt',conversion:literal.conversion,castEffect:literal.effect});stack.push(local[0]);}
          else stack.push(typeof t.value==='number'?scalar(literal?.type||typeIR.numericName(info?.output?.item)||(t.numericKind==='float'||!Number.isInteger(t.value)?'float':'int'),t.value):t.value);
        }
        else if(t.kind==='interpolation') {
          const count=t.fields.filter(f=>f.empty).length;this.need(stack,count,t);
          const values=count?stack.splice(-count):[];let index=0,result=t.chunks[0];
          for(let i=0;i<t.fields.length;i++){
            const f=t.fields[i],value=f.empty?values[index++]:yield* this.operand(f.body,env,missing,t,'Interpolation');
            const local=[value];
            if(typeof value!=='string'||this.definitions.classes?.get('show')?.instances.has('string'))
              yield* BUILTINS.get('show')(this,local,{...t,showEffect:info?.formatEffects?.[i]});
            result+=local[0]+t.chunks[i+1];
          }
          stack.push(result);
        }
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
        else if(t.kind==='dict'){let result=emptyDict();for(let j=0;j<t.fields.length;j+=2){const key=yield* this.operand(t.fields[j].body,env,missing,t,'Dictionary key'),value=yield* this.operand(t.fields[j+1].body,env,missing,t,'Dictionary value'),hash=yield* this.hashValue(key,t);result=dictSet(result,key,value,hash,equal);}stack.push(result);}
        else if(t.kind==='path-update') {
          this.need(stack,1,t);const original=stack.pop(),args=[];
          for(const field of t.fields.slice(0,-1))args.push(yield* this.operand(field.body,env,missing,t,'Update index'));
          const vm=this;
          function* copy(value,depth) {
            if(depth===t.path.length){
              const result=t.updating?[value]:[];
              yield* vm.run(t.fields.at(-1).body,result,new Map(env),t.updating?new Map():missing);
              if(result.length!==1)throw new LanguageError('Update must produce exactly one value',t);return result[0];
            }
            const part=t.path[depth];
            if(part.kind==='field') {
              if(value?.kind!=='record'||!Object.hasOwn(value.fields,part.name))throw new LanguageError(`Missing record field: ${part.name}`,t);
              const replacement=yield* copy(value.fields[part.name],depth+1);
              return {kind:'record',fields:{...value.fields,[part.name]:replacement}};
            }
            if(part.kind==='tuple-index') {
              if(value?.kind!=='tuple'||part.index>=value.items.length)throw new LanguageError('Tuple index out of bounds',t);
              const items=[...value.items];items[part.index]=yield* copy(items[part.index],depth+1);return {kind:'tuple',items};
            }
            const index=args[part.argument],local=[value,index],last=depth===t.path.length-1;
            let found=true;
            if(part.optional||t.defaulting&&last){
              const iterator=BUILTINS.get('at')(vm,local,{...t,indexEffect:info?.indexPaths?.[depth]?.get});
              try{let step=iterator.next();while(!step.done){if(step.value.operation.name==='exn'){found=false;break;}const returned=yield step.value;step=iterator.next(returned);}}finally{iterator.return();}
              if(!found&&part.optional||found&&t.defaulting&&last)return value;
            }else if(!last||t.updating)yield* BUILTINS.get('at')(vm,local,{...t,indexEffect:info?.indexPaths?.[depth]?.get});
            const replacement=yield* copy(local[0],depth+1),updated=[value,index,replacement];
            yield* BUILTINS.get('setAt')(vm,updated,{...t,indexEffect:info?.indexPaths?.[depth]?.set,reuseVector:depth===0&&vm.vectorReuse.has(t)});return updated[0];
          }
          stack.push(yield* copy(original,0));
        }
        else if(t.kind==='list-index') {
          this.need(stack,1,t);const value=stack.pop(),index=yield* this.operand(t.body,env,missing,t,'Index'),local=[value,index];
          const iterator=BUILTINS.get('at')(this,local,{...t,indexEffect:info?.indexGet});let failed=false;
          try{let step=iterator.next();while(!step.done){if(t.optional&&step.value.operation.name==='exn'){failed=true;break;}const returned=yield step.value;step=iterator.next(returned);}}finally{iterator.return();}
          stack.push(t.optional?{kind:'adt',typeName:'option',constructor:failed?'None':'Some',fields:failed?[]:[local[0]]}:local[0]);
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
        else if (t.kind === 'quote') stack.push({ kind: 'closure', body: t.body, env: new Map(env),...(t.blockLabel?{blockLabel:t.blockLabel,labelName:t.labelName}:{}) });
        else if (env.has(t.value)) {
          const value=env.get(t.value);
          if(value?.kind==='local-function')yield* this.run(value.body,stack,new Map(value.env),new Map(),dispatch&&info?.effect?dispatch.local(value,info.effect):undefined);
          else stack.push(value?.kind==='cell'?value.value:value);
          if(t.ephemeral){env.delete(t.value);env.locals?.delete(t.value);}
        }
        else if(this.definitions.effects?.has(t.value)) {
          const op=this.definitions.effects.get(t.value);this.need(stack,op.inputCount,t);
          const args=op.syntax.input[0]?.tag==='stack-row'?stack.splice(0):op.inputCount?stack.splice(-op.inputCount):[];
          let outputCount=op.outputCount;if(op.syntax.output[0]?.tag==='stack-row'&&info?.effect){outputCount=0;let out=typeIR.prune(info.effect.output);while(out.tag==='push'){outputCount++;out=typeIR.prune(out.rest);}}
          const returned=yield {operation:op,args,outputCount,token:t,...(t.target?{target:this.labelTarget(env.get(t.target),t)}:{})};
          if(op.never)throw new LanguageError('Non-returning effect returned',t);
          stack.push(...returned);
        }
        else if (BUILTINS.has(t.value)) {
          const token={...t,...(t.value==='show'?{showEffect:info?.effect}:{}),...(this.definitions.methods?.get(t.value)?.specialBits?{bitEffect:info?.effect}:{}),...(['at','setAt'].includes(t.value)?{indexEffect:info?.effect}:{}),...(this.definitions.methods?.get(t.value)?.specialCast?{castEffect:info?.effect,conversion:info?.effect&&dispatch?.castInfo(t,info.effect)}:{}),reuseVector:this.vectorReuse.has(t),...(t.handlerLabel?{label:env.get(t.handlerLabel)}:{})};
          if(dispatch&&info && (!dispatch.numericOnly||['call','each','vmap','vfilter','while','when','if','dip','compose','maxiBy','miniBy','all','any',...transforms.keys()].includes(t.value)) && stack.some(v=>v&&typeof v==='object'))token.quotations=dispatch.argumentsPlan(stack,info.input,t);
          yield* BUILTINS.get(t.value)(this,stack,token);
        }
        else if(this.definitions.constructors?.has(t.value)) {
          const constructor=this.definitions.constructors.get(t.value),count=constructor.fields.length;
          this.need(stack,count,t);
          stack.push({kind:'adt',typeName:constructor.typeName,constructor:t.value,fields:count ? stack.splice(-count) : []});
        }
        else if(this.definitions.methods?.has(t.value)) {
          const m=this.definitions.methods.get(t.value),c=this.definitions.classes.get(m.className);
          this.need(stack,m.inputCount,t);const v=stack[stack.length-m.inputCount+m.dispatchIndex];
          const key=runtimeTypeKey(v);
          const target=dispatch&&info?.effect?dispatch.target(t,info.effect):c.instances.get(key)?.implementations.get(t.value);
          if(!target)throw new LanguageError(`No instance: ${c.name} ${key||format(v)}`,t);
          const call={...t,value:target};yield* this.run([call],stack,env,new Map(),info?new Map([[call,info]]):undefined);
        }
        else if (this.definitions.has(t.value)) {
          const clauses = this.definitions.get(t.value), arity = clauses[0].patterns.length;
          this.need(stack, arity, t);
          const args = arity ? stack.slice(-arity) : [];
          let bindings,selectedStack,bodyTrace;
          let clause;
          for(const c of clauses) {
            const matched=new Map();
            if(!c.patterns.every((p,i)=>matchPattern(p,args[i],matched,this.typePlan.valueType)))continue;
            const candidate=new Map(this.globals);candidate.locals=new Set(matched.keys());
            for(const [name,value] of matched)candidate.set(name,value);
            const trial=arity?stack.slice(0,-arity):[...stack];
            const typed=dispatch&&info?.effect?dispatch.clause(c,info.effect):undefined;
            if(c.guard) {
              yield* this.run(c.guard,trial,new Map(candidate),new Map(),typed);this.need(trial,1,c.token);
              if(!this.expect(trial.pop(),'boolean',c.token))continue;
            }
            bindings=candidate;selectedStack=trial;clause=c;bodyTrace=typed;break;
          }
          if (!clause) throw new LanguageError(`No matching pattern for ${t.value}`, t);
          stack.splice(0,stack.length,...selectedStack);
          yield* this.run(clause.body, stack, bindings,new Map(),bodyTrace);
        } else throw new LanguageError(`Unknown word: ${t.value}`, t);
      }
    } finally { this.depth--;this.currentTrace=previousTrace; }
  }
}

const BUILTINS = new Map();
const define = (name, count, fn) => BUILTINS.set(name, function*(vm, s, t) { vm.need(s, count, t); const result=fn(vm,s,t);if(result?.next)yield* result; });
define('handle',2,function*(vm,s,t){
  const handlers=s.pop(),body=vm.expect(s.pop(),'quotation',t);
  if(handlers?.kind!=='record')throw new LanguageError('handle requires a handler record',t);
  for(const [name,q] of Object.entries(handlers.fields)){if(!ioEffects(vm.definitions.effects).has(name))throw new LanguageError(`Unknown effect: ${name}`,t);vm.expect(q,'quotation',t);}
  const local=[],generator=vm.call(body,local,t);
  const target={},previous=t.label?.current;if(t.label)t.label.current=target;
  try{s.push(...(yield* vm.handle(generator,local,handlers,t,undefined,target)));}finally{generator.return();if(t.label)t.label.current=previous;}
});
define('resume',1,function*(vm,s,t){
  const k=s.pop();if(k?.kind!=='continuation')throw new LanguageError('resume requires a continuation',t);
  if(k.never)throw new LanguageError('Cannot resume a non-returning effect',t);
  if(!k.active||k.used)throw new LanguageError('Continuation is expired or already resumed',t);
  vm.need(s,k.inputCount,t);const returned=k.inputCount?s.splice(-k.inputCount):[];k.used=true;
  s.push(...(yield* k.resume(returned)));
});
define('nop',0,()=>{});
for(const name of ['+','-','*','/','%','^','<','>','<=','>='])define(name,2,(vm,s,t)=>{
 const b=s.pop(),a=s.pop();try{s.push(numericBinary(name,a,b));}catch(e){throw new LanguageError(e.message,t);}
});
for (const name of ['==', '/=']) define(name, 2, (_vm,s) => { const b=s.pop(), a=s.pop(); s.push(name === '==' ? equal(a,b) : !equal(a,b)); });
for(const name of ['&&','||'])define(name,2,(vm,s,t)=>{const b=vm.expect(s.pop(),'boolean',t),a=vm.expect(s.pop(),'boolean',t);s.push(name==='&&'?a&&b:a||b);});
for(const name of [...bitOperators,...bitFunctions])define(name,2,function*(vm,s,t){
 const b=s.pop(),a=s.pop(),m=vm.definitions.methods?.get(name),target=m&&vm.definitions.classes.get(m.className).instances.get(runtimeTypeKey(a))?.implementations.get(name);
 if(target){const call={...t,kind:'word',value:target},effect=t.bitEffect,values=[a,b];yield* vm.run([call],values,new Map(vm.globals),new Map(),effect?new Map([[call,{input:effect.input,effect}]]):undefined);s.push(values[0]);return;}
 try{s.push(bitOperation(name,a,b));}catch(error){if(error.bitIndex){yield {operation:ioEffects().get('exn'),args:[error.message],token:t};throw new LanguageError('Non-returning effect returned',t);}throw new LanguageError(error.message,t);}
});
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
define('while',2,function*(vm,s,t){t={...t};
  const body=vm.expect(s.pop(),'quotation',t),condition=vm.expect(s.pop(),'quotation',t);let checkpoint=[...s];
  const completed=yield* vm.loop((function*(){while(true){checkpoint=[...s];if(++vm.steps>vm.maxSteps)throw new LanguageError('Execution step limit exceeded',t);
    yield* vm.call(condition,s,t);vm.need(s,1,t);const flag=vm.expect(s.pop(),'boolean',t);checkpoint=[...s];if(!flag)break;yield* vm.call(body,s,t);
  }})(),t);if(!completed)s.splice(0,s.length,...(t.breakValues||checkpoint));
});
define('dip',2,function*(vm,s,t){ const q=s.pop(),value=s.pop(); yield* vm.call(q,s,t); s.push(value); });
define('compose',2,(vm,s,t)=>{
  const b=vm.expect(s.pop(),'quotation',t),a=vm.expect(s.pop(),'quotation',t);
  s.push({kind:'closure',env:new Map([['__a',a],['__b',b]]),body:lex('__a call __b call',t.file)});
});
for(const name of ['vmap','vfilter'])define(name,2,function*(vm,s,t){t={...t};
  const q=vm.expect(s.pop(),'quotation',t),xs=s.pop(),results=[];
  let checkpoint=[...s];const completed=yield* vm.loop(vm.walk(xs,function*(value){checkpoint=[...s];s.push(value);yield* vm.call(q,s,t);vm.need(s,1,t);const result=s.pop();if(name==='vmap')results.push(result);else if(vm.expect(result,'boolean',t))results.push(value);},t),t);if(!completed)s.splice(0,s.length,...(t.breakValues||checkpoint));
  if(!t.breakValues)s.push(results);
});
define('each',2,function*(vm,s,t){t={...t};const q=vm.expect(s.pop(),'quotation',t),xs=s.pop();let checkpoint=[...s];const completed=yield* vm.loop(vm.walk(xs,function*(value){checkpoint=[...s];s.push(value);yield* vm.call(q,s,t);},t),t);if(!completed)s.splice(0,s.length,...(t.breakValues||checkpoint));});
for(const name of ['windows','chunks','chunkBy','groupBy'])define(name,2,function*(vm,s,t){
  t={...t};const argument=s.pop(),source=s.pop();
  if(name==='windows'||name==='chunks'){
    if(!Number.isSafeInteger(argument)||argument<=0){yield {operation:ioEffects().get('exn'),args:[name+': size must be a positive integer'],token:t};throw new LanguageError('Non-returning effect returned',t);}
  }
  if(name==='groupBy'){
    const block=vm.expect(argument,'quotation',t);let result=emptyDict();
    yield* vm.loop(vm.walk(source,function*(item){const local=[item];yield* vm.call(block,local,t);vm.need(local,1,t);const key=local.pop(),hash=yield* vm.hashValue(key,t),old=dictGet(result,key,hash,equal),items=old?old.value:[];items.push(item);result=dictSet(result,key,items,hash,equal);},t),t);
    s.push(...(t.breakValues||[result]));return;
  }
  s.push({kind:'stream',mode:'partition',operation:name,source,label:t.label,...(name==='chunkBy'?{block:vm.expect(argument,'quotation',t)}:{count:argument})});
});
for(const name of ['zip','vzip'])define(name,2,function*(vm,s,t){t={...t};const right=s.pop(),left=s.pop(),value={kind:'stream',mode:'zip',left,right,label:t.label,eager:name==='vzip'};if(name==='zip')s.push(value);else{const result=[];yield* vm.loop(vm.walk(value,function*(item){result.push(item);},t),t);if(t.breakValues)s.splice(0,s.length,...t.breakValues);else s.push(result);}});
define('nth',2,function*(vm,s,t){t={...t};let remaining=vm.expect(s.pop(),'number',t);const source=s.pop(),stop={};let result={kind:'adt',typeName:'option',constructor:'None',fields:[]};
 if(Number.isSafeInteger(remaining)&&remaining>=0){try{yield* vm.loop(vm.walk(source,function*(item){if(remaining--===0){result={kind:'adt',typeName:'option',constructor:'Some',fields:[item]};throw stop;}},t),t);}catch(error){if(error!==stop)throw error;}}
 if(t.breakValues)s.splice(0,s.length,...t.breakValues);else s.push(result);
});
define('toVector',1,function*(vm,s,t){t={...t};const xs=s.pop(),result=[];yield* vm.loop(vm.walk(xs,function*(value){result.push(value);},t),t);if(t.breakValues)s.splice(0,s.length,...t.breakValues);else s.push(result);});
for(const [name,mode] of transforms)define(name,mode==='flatten'?1:2,function*(vm,s,t){
  const argument=mode==='flatten'?null:s.pop(),source=s.pop();
  if(countTransform(mode) && (!Number.isSafeInteger(argument)||argument<0)){
    yield {operation:ioEffects().get('exn'),args:[`${name}: count must be a nonnegative safe integer`],token:t};throw new LanguageError('Non-returning effect returned',t);
  }
  const value={kind:'stream',mode,source,label:t.label,eager:!streamTransforms.has(name),...(countTransform(mode)?{count:argument}:callbackTransform(mode)?{block:vm.expect(argument,'quotation',t)}:{})};
  if(streamTransforms.has(name))s.push(value);
  else {t={...t};const result=[];yield* vm.loop(vm.walk(value,function*(item){result.push(item);},t),t);if(t.breakValues)s.splice(0,s.length,...t.breakValues);else s.push(result);}
});
define('fromYield',1,(vm,s,t)=>{s.push({kind:'stream',mode:'fromYield',label:t.label,block:vm.expect(s.pop(),'quotation',t)});});
define('fold',3,function*(vm,s,t){t={...t};const q=vm.expect(s.pop(),'quotation',t);let acc=s.pop();const xs=s.pop();let checkpoint=[...s];
  const completed=yield* vm.loop(vm.walk(xs,function*(value){checkpoint=[...s];s.push(acc,value);yield* vm.call(q,s,t);vm.need(s,1,t);acc=s.pop();},t),t);
  if(!completed)s.splice(0,s.length,...(t.breakValues||checkpoint));if(!t.breakValues)s.push(acc);
});
// Collection is eager; sort keys run once, and merge passes preserve equal-key order.
for(const name of ['reverse','sort','sortBy'])define(name,name==='sortBy'?2:1,function*(vm,s,t){t={...t};
  const q=name==='sortBy'?vm.expect(s.pop(),'quotation',t):null,xs=s.pop();let rows=[];
  yield* vm.loop(vm.walk(xs,function*(value){
    let key=value;if(q){const local=[value];yield* vm.call(q,local,t);vm.need(local,1,t);key=local.pop();}
    rows.push({value,key});
  },t),t);
  if(t.breakValues){s.splice(0,s.length,...t.breakValues);return;}
  if(name==='reverse')rows.reverse();
  else yield* vm.loop((function*(){
    for(let width=1;width<rows.length;width*=2){
      const next=[];
      for(let start=0;start<rows.length;start+=2*width){
        let i=start,j=Math.min(start+width,rows.length);const end=Math.min(start+2*width,rows.length),mid=j;
        while(i<mid&&j<end){
          if(++vm.steps>vm.maxSteps)throw new LanguageError('Execution step limit exceeded',t);
          const pair=[rows[j].key,rows[i].key];yield* vm.binary('<',pair,t);
          next.push(vm.expect(pair[0],'boolean',t)?rows[j++]:rows[i++]);
        }
        while(i<mid)next.push(rows[i++]);while(j<end)next.push(rows[j++]);
      }
      rows=next;
    }
  })(),t);
  if(t.breakValues)s.splice(0,s.length,...t.breakValues);else s.push(rows.map(row=>row.value));
});
for(const name of ['max','min'])define(name,2,function*(vm,s,t){const b=s.pop(),a=s.pop(),pair=[b,a];yield* vm.binary('<',pair,t);const less=vm.expect(pair[0],'boolean',t);s.push(name==='max'?(less?a:b):(less?b:a));});
for(const name of ['maxi','mini','maxiBy','miniBy','all','any'])define(name,['maxi','mini'].includes(name)?1:2,function*(vm,s,t){t={...t};
 const predicate=name==='all'||name==='any',q=['maxi','mini'].includes(name)?null:vm.expect(s.pop(),'quotation',t),xs=s.pop(),stop={};let best,key,found=false,result=name==='all';
 try{yield* vm.loop(vm.walk(xs,function*(value){
  let next=value;if(q){const local=[value];yield* vm.call(q,local,t);vm.need(local,1,t);next=local.pop();}
  if(predicate){result=vm.expect(next,'boolean',t);if(name==='all'?!result:result)throw stop;return;}
  let replace=!found;if(found){const pair=[next,key];yield* vm.binary('<',pair,t);const less=vm.expect(pair[0],'boolean',t);replace=name.startsWith('maxi')?!less:less;}
  if(replace){best=value;key=next;found=true;}
 },t),t);}catch(error){if(error!==stop)throw error;}
 if(t.breakValues){s.splice(0,s.length,...t.breakValues);return;}
 s.push(predicate?result:{kind:'adt',typeName:'option',constructor:found?'Some':'None',fields:found?[best]:[]});
});

define('cons',2,(vm,s,t)=>{ const list=vm.expect(s.pop(),'list',t),x=s.pop(); s.push([x,...list]); });
define('Push',2,(vm,s,t)=>{const x=s.pop(),xs=vm.expect(s.pop(),'list',t);if(t.reuseVector){vm.vectorUpdates.inPlace++;xs.push(x);s.push(xs);}else{vm.vectorUpdates.copied++;s.push([...xs,x]);}});
BUILTINS.set('push', BUILTINS.get('Push'));
BUILTINS.set('::', BUILTINS.get('Push'));
define('concat',2,(vm,s,t)=>{ const b=vm.expect(s.pop(),'list',t),a=vm.expect(s.pop(),'list',t); if(t.reuseVector){vm.vectorUpdates.inPlace++;for(const x of b)a.push(x);s.push(a);}else{vm.vectorUpdates.copied++;s.push([...a,...b]);} });
define('++',2,(vm,s,t)=>{
  if(typeof s.at(-2)==='string'){const b=vm.expect(s.pop(),'string',t),a=s.pop();s.push(a+b);}
  else return BUILTINS.get('concat')(vm,s,t);
});
define('length',1,(vm,s,t)=>s.push(vm.expect(s.pop(),'list',t).length));
for(const name of ['head','tail']) define(name,1,(vm,s,t)=>{ const list=vm.expect(s.pop(),'list',t); if(!list.length) throw new LanguageError(`${name}: empty list`,t); s.push(name==='head'?list[0]:list.slice(1)); });
for(const name of ['range','..','..='])define(name,2,(vm,s,t)=>{
  const end=vm.expect(s.pop(),'number',t),start=vm.expect(s.pop(),'number',t);
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||Math.abs(end-start)>100000)
    throw new LanguageError(`${name} requires safe integers at most 100000 apart`,t);
  const step=start<=end?1:-1,count=Math.abs(end-start)+(name==='..'?0:1);
  s.push(name==='range'?Array.from({length:count},(_,i)=>start+i*step):{kind:'range',start,end,inclusive:name==='..='});
});
define('read',0,function*(vm,s,t){const result=yield {operation:ioEffects().get('read'),args:[],token:t};s.push(result[0]);});
define('exn',1,function*(vm,s,t){yield {operation:ioEffects().get('exn'),args:[vm.expect(s.pop(),'string',t)],token:t};throw new LanguageError('Cannot resume a non-returning effect',t);});
define('put',1,function*(vm,s,t){const value=vm.expect(s.pop(),'string',t);yield {operation:ioEffects().get('put'),args:[value],token:t};});
define('print',1,function*(vm,s,t){const value=s.pop();yield {operation:ioEffects().get('put'),args:[typeof value==='string'?value:format(value)],token:t};});
define('show',1,function*(vm,s,t){
  const target=vm.definitions.classes?.get('show')?.instances.get(runtimeTypeKey(s.at(-1)))?.implementations.get('show');
  if(target){const call={...t,kind:'word',value:target};yield* vm.run([call],s,new Map(vm.globals),new Map(),t.showEffect?new Map([[call,{input:t.showEffect.input,effect:t.showEffect}]]):undefined);}
  else s.push(format(s.pop()));
});
define('split',2,(vm,s,t)=>{const separator=vm.expect(s.pop(),'string',t),source=vm.expect(s.pop(),'string',t);s.push({kind:'stream',mode:'split',source,separator});});
define('join',2,function*(vm,s,t){t={...t};const separator=vm.expect(s.pop(),'string',t),xs=s.pop(),parts=[];
  yield* vm.loop(vm.walk(xs,function*(value){parts.push(vm.expect(value,'string',t));},t),t);if(t.breakValues)s.splice(0,s.length,...t.breakValues);else s.push(parts.join(separator));
});
const numberText=/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
for(const name of ['toNum','parseNum'])define(name,1,function*(vm,s,t){
  const source=vm.expect(s.pop(),'string',t),text=source.replace(/^[ \t\r\n\v\f]+|[ \t\r\n\v\f]+$/g,''),n=numberText.test(text)?Number(text):NaN;
  if(name==='toNum')s.push(Number.isFinite(n)?{kind:'adt',typeName:'option',constructor:'Some',fields:[scalar('float',n)]}:{kind:'adt',typeName:'option',constructor:'None',fields:[]});
  else if(Number.isFinite(n))s.push(scalar('float',n));
  else {yield {operation:ioEffects().get('exn'),args:['Invalid number: '+format(source)],token:t};throw new LanguageError('Cannot resume a non-returning effect',t);}
});
export const builtinNames = () => [...BUILTINS.keys()].sort();
import { checkDefinitions, checkExpression, inferExpression, missingOperands, typeIR } from './types.mjs';
export { StaticTypeError } from './types.mjs';


for(const name of combinationNames)define(name,name==='powerset'?1:2,function*(vm,s,t){
 const arg=name==='powerset'?null:s.pop(),source=s.pop();
 if(!['powerset','cartesianProduct'].includes(name)&&(!Number.isSafeInteger(arg)||arg<0)){
  yield {operation:ioEffects().get('exn'),args:[name+': count must be a nonnegative safe integer'],token:t};throw new LanguageError('Non-returning effect returned',t);
 }
 s.push({kind:'stream',mode:'combinatorial',operation:name,source,...(name==='cartesianProduct'?{right:arg}:{count:arg})});
});

define('chars',1,(vm,s,t)=>{const value=vm.expect(s.pop(),'string',t);s.push([...value].map(c=>scalar('char',c)));});
for(const name of ['from',...['to','from'].flatMap(prefix=>['Int','Float','Byte','Char'].map(t=>prefix+t))])define(name,1,function*(vm,s,t){
 const value=s.pop(),info=t.conversion,target=info?.target;
 if(target&&target!==name){const call={...t,kind:'word',value:target},effect=t.castEffect,local=[value];yield* vm.run([call],local,new Map(vm.globals),new Map(),effect?new Map([[call,{input:effect.input,effect}]]):undefined);s.push(local[0]);return;}
 const type=info?.destination||(name.startsWith('to')?name.slice(2).toLowerCase():null);
 if(!type)throw new LanguageError('Ambiguous conversion: '+name,t);
 if(type==='char'&&scalarType(value)==='char'){s.push(value);return;}
 const n=scalarType(value)==='char'?scalarValue(value).codePointAt(0):scalarValue(value);let result=type==='float'?n:Math.trunc(n);
 if(!['int','float','byte','char'].includes(scalarType(value))||!Number.isFinite(result)||type==='byte'&&(result<0||result>255)||type==='int'&&Math.abs(result)>9223372036854775807||type==='char'&&(result<0||result>0x10ffff||result>=0xd800&&result<=0xdfff)){
  yield {operation:ioEffects().get('exn'),args:['Invalid numeric cast to '+type],token:t};throw new LanguageError('Non-returning effect returned',t);
 }
 s.push(scalar(type,type==='char'?String.fromCodePoint(result):result));
});
define('hash',1,function*(vm,s,t){const value=s.pop(),target=vm.definitions.classes?.get('hash')?.instances.get(runtimeTypeKey(value))?.implementations.get('hash');if(target){const local=[value];yield* vm.run([{...t,kind:'word',value:target}],local,new Map(vm.globals));s.push(local[0]);}else s.push(yield* vm.hashValue(value,t));});
define('values',1,(vm,s,t)=>{const source=s.pop();if(source?.kind!=='dict')throw new LanguageError('values requires a dictionary',t);s.push({kind:'stream',mode:'dict-values',source});});
define('bytes',1,(vm,s,t)=>s.push([...new TextEncoder().encode(vm.expect(s.pop(),'string',t))].map(v=>scalar('byte',v))));
for(const name of ['at','setAt'])define(name,name==='at'?2:3,function*(vm,s,t){
 const count=name==='at'?2:3,values=s.splice(-count),container=values[0],index=values[1];
 const target=vm.definitions.classes?.get(name==='at'?'indexGet':'indexSet')?.instances.get(runtimeTypeKey(container))?.implementations.get(name);
 if(target){const call={...t,kind:'word',value:target},effect=t.indexEffect;yield* vm.run([call],values,new Map(vm.globals),new Map(),effect?new Map([[call,{input:effect.input,effect}]]):undefined);s.push(values[0]);return;}
 if(container?.kind==='dict'){const hash=yield* vm.hashValue(index,t),found=dictGet(container,index,hash,equal);if(name==='at'){if(!found){yield {operation:ioEffects().get('exn'),args:['Dictionary key not found: '+format(index)],token:t};throw new LanguageError('Non-returning effect returned',t);}s.push(found.value);}else s.push(dictSet(container,index,values[2],hash,equal));return;}
 const xs=typeof container==='string'?new TextEncoder().encode(container):vm.expect(container,'list',t);
 if(scalarType(index)!=='int'||!Number.isSafeInteger(index)||index<0||index>=xs.length){yield {operation:ioEffects().get('exn'),args:['Index out of bounds: '+format(index)],token:t};throw new LanguageError('Non-returning effect returned',t);}
 if(name==='at'){s.push(typeof container==='string'?scalar('byte',xs[index]):xs[index]);return;}
 if(typeof container==='string'){
  const bytes=new Uint8Array(xs);bytes[index]=scalarValue(values[2]);try{s.push(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{yield {operation:ioEffects().get('exn'),args:['String update produces invalid UTF-8'],token:t};throw new LanguageError('Non-returning effect returned',t);}
 }else{const result=t.reuseVector?xs:[...xs];vm.vectorUpdates[t.reuseVector?'inPlace':'copied']++;result[index]=values[2];s.push(result);}
});
