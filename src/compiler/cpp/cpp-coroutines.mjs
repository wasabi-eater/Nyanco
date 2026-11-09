import {readFileSync} from 'node:fs';

// Lower the structured C++ emitted by our backend, including its selected
// runtime fragments. Propagation follows calls and callback contracts. Keeping
// this after runtime selection leaves programs with no resumable boundary on
// the existing synchronous path, with no coroutine headers or frame overhead.
export function lowerCppCoroutines(source) {
  if(!/^class EffectWorker \{/m.test(source))return source;
  source=source.replace(/^class EffectWorker \{[\s\S]*?\n\};/m,'/* COROUTINE_WORKER */');
  source=source.replace(/^\/\/ Suspending a worker[^\n]*\r?\n\/\/ The driver[^\n]*\r?\n\/\/ results[^\n]*\r?\n/m,'');
  source=source.replace(/^struct Abandoned \{\};\r?\n/m,'');
  source=source.replace(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\bEffectWorker\b/g,t=>t==='EffectWorker'?'CoroutineWorker':t);
  const tokens=[];
  for(const m of source.matchAll(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[A-Za-z_]\w*|::|->|&&|\|\||\S/g)){
    if(m[0].startsWith('//')||m[0].startsWith('/*'))continue;
    tokens.push({v:m[0],a:m.index,b:m.index+m[0].length});
  }
  const stack=[],pairs=new Map();
  for(let i=0;i<tokens.length;i++){
    const v=tokens[i].v;
    if(['(','[','{'].includes(v))stack.push(i);
    else if([')',']','}'].includes(v)){const j=stack.pop();if(j===undefined||tokens[j].v!==({')':'(',']':'[','}':'{'})[v])throw Error('Unbalanced generated C++');pairs.set(i,j);pairs.set(j,i);}
  }
  const raw=(a,b)=>a>=b?'':source.slice(tokens[a].a,tokens[b-1].b);
  const literals=tokens.filter(t=>['"',"'"].includes(t.v[0]));
  const codeAt=index=>!literals.some(t=>t.a<=index&&index<t.b);
  const nodes=[],controls=new Set(['if','constexpr','for','while','switch','catch','sizeof','alignof']);
  for(let i=0;i<tokens.length;i++)if(tokens[i].v==='{'){
    let p=i-1;
    while(p>=0&&![')',']',';','{','}'].includes(tokens[p].v))p--;
    if(p<0||![')',']'].includes(tokens[p].v))continue;
    const open=pairs.get(p),prev=tokens[open-1]?.v;
    const lambda=tokens[p].v===']'||prev===']';
    if(!lambda&&(!/^[A-Za-z_]\w*$/.test(prev||'')||controls.has(prev)))continue;
    if(!lambda&&!/^(?:(?:const|noexcept|override|final)\s*)*$/.test(raw(p+1,i).trim()))continue;
    let capture=lambda?(tokens[p].v===']'?open:pairs.get(open-1)):null;
    let start=lambda?capture:open-2;
    if(!lambda){while(start>0&&![';','{','}'].includes(tokens[start-1].v))start--;}
    let prefix=raw(start,open-1).replace(/^\s*template\s*<[^\n]*?>\s*/,'').replace(/\binline\s+|\[\[noreturn\]\]\s*/g,'').trim();
    if(!lambda&&(!prefix||prefix.includes('=')||prefix.includes('return')))continue;
    const arrow=Array.from({length:i-p-1},(_,j)=>p+1+j).find(j=>tokens[j].v==='->');
    const header=raw(start,i),params=tokens[p].v===']'?'':raw(open+1,p);
    const name=lambda?(tokens[capture-1]?.v==='='?tokens[capture-2]?.v:null):prev;
    const node={start,open:i,end:pairs.get(i),lambda,name,params,header,type:lambda?(arrow===undefined?null:raw(arrow+1,i).trim()):prefix,arrow,async:false};
    nodes.push(node);
  }
  const owner=i=>{let best;for(const n of nodes)if(n.open<i&&i<n.end&&(!best||n.open>best.open))best=n;return best;};
  for(const n of nodes)n.parent=owner(n.start);
  const byName=new Map();for(const n of nodes)if(n.name){if(!byName.has(n.name))byName.set(n.name,[]);byName.get(n.name).push(n);}
  const local=(name,n)=>{for(let p=n;p;p=p.parent){const found=nodes.find(x=>x.lambda&&x.name===name&&x.parent===p);if(found)return found;}return null;};
  const directReturn=n=>tokens.some((t,i)=>t.v==='return'&&tokens[i+1]?.v!==';'&&owner(i)===n);
  for(const n of nodes)if(n.lambda){
    const machine=/\bMachine\s*&/.test(n.params),event=/\bEvent\s+/.test(n.params),continuation=/\bContinuation\b/.test(n.params);
    const visitor=/^\s*(?:Value\s+\w+|\w+(?:::\w+)*(?:<\w+>)?\s+typedItem\w*)\s*$/.test(n.params),walker=/\b(?:Visit|TypedVisit)\b/.test(n.params);
    const typedCallback=/\b(?:typedItem|pairField)\d+\b/.test(n.params)||/^repeated\d+$/.test(n.name||'');
    const compare=!typedCallback&&(n.type?['bool','int','std::string','std::size_t'].includes(n.type):/const Value& a,\s*const Value& b\s*$/.test(n.params));
    // hash/eq/ord callbacks have closed effect signatures. Their implementation
    // may handle effects internally, but cannot suspend their synchronous STL
    // caller. Drive such an internal task to completion at this ABI boundary.
    n.syncContract=!!compare||n.name==='hash'&&/^const Value& key$/.test(n.params.trim())||n.name==='equal';
    n.async=event||continuation||visitor||walker||machine&&!compare;
    if(!n.type)n.type=event||continuation?'Values':visitor&&directReturn(n)?'Value':directReturn(n)?'Values':'void';
  }
  const callbackNames=new Set(['body','route','visit','source','left','right','fn','nested','key','replace','drive','second','WalkText','scan']);
  function calleeStart(i){
    let j=i;
    if(tokens[j]?.v===')'||tokens[j]?.v===']'){const a=pairs.get(j);j=tokens[j].v===')'?calleeStart(a-1):a;}
    else if(tokens[j]?.v==='>'){
      let depth=1;j--;while(j>=0&&depth){if(tokens[j].v==='>')depth++;if(tokens[j].v==='<')depth--;j--;}j=calleeStart(j);
    }
    if(['.','->','::'].includes(tokens[j-1]?.v))j=calleeStart(j-2);
    return j;
  }
  const calls=[];
  for(let i=0;i<tokens.length;i++)if(tokens[i].v==='('){
    if(tokens[i-1]?.v===')'){
      const wrapped=pairs.get(i-1),target=nodes.find(n=>n.lambda&&n.start>wrapped&&n.end<i-1);
      const n=owner(i);if(target&&n)calls.push({target,start:wrapped,end:pairs.get(i),owner:n,index:i});
      continue;
    }
    let j=i-1;
    if(tokens[j]?.v==='>'){let depth=1;j--;while(j>=0&&depth){if(tokens[j].v==='>')depth++;if(tokens[j].v==='<')depth--;j--;}}
    const name=tokens[j]?.v;if(!/^[A-Za-z_]\w*$/.test(name||'')||controls.has(name))continue;
    const n=owner(i);if(!n||i<=n.open)continue;
    // Parameter lists and declarations inside a surrounding function are not calls.
    if(nodes.some(x=>i>x.start&&i<x.open))continue;
    calls.push({name,start:calleeStart(i-1),end:pairs.get(i),owner:n,index:i,local:local(name,n)});
  }
  function suspends(c){
    if(c.target)return c.target.async;
    if(tokens[c.index-2]?.v==='::'&&tokens[c.index-3]?.v==='std')return false;
    if(c.local)return c.local.async;
    if(c.name==='perform'||c.name==='exception'||c.name==='resume')return true;
    if(['get','set'].includes(c.name))return tokens[c.index-2]?.v==='.'&&tokens[c.index-3]?.v==='part';
    if(c.name==='next')return tokens[c.index-2]?.v==='.'&&tokens[c.index-3]?.v!=='worker'; // Cursor; CoroutineWorker is synchronous.
    if(callbackNames.has(c.name))return true;
    return byName.get(c.name)?.some(n=>!n.lambda&&n.async)||false;
  }
  let changed=true;while(changed){changed=false;for(const c of calls)if(suspends(c)&&!c.owner.async&&!c.owner.syncContract){c.owner.async=true;changed=true;}}
  const edits=[];const edit=(a,b,text)=>edits.push({a,b,text});
  // Callback types form the suspension ABI of the selected stream/runtime path.
  const aliases=[
    [/std::function<void\(Value\)>/g,'std::function<Task<void>(Value)>'],
    [/std::function<Values\(Values\)>/g,'std::function<Task<Values>(Values)>'],
    [/std::function<Values\(Event\)>/g,'std::function<Task<Values>(Event)>'],
    [/std::function<Values\(const Values&, Ptr<Continuation>\)>/g,'std::function<Task<Values>(const Values&, Ptr<Continuation>)>'],
    [/std::function<void\(Machine&, const Visit&\)>/g,'std::function<Task<void>(Machine&, const Visit&)>'],
    [/std::function<void\(T\)>/g,'std::function<Task<void>(T)>'],
    [/std::function<void\(Machine&, const TypedVisit<T>&\)>/g,'std::function<Task<void>(Machine&, const TypedVisit<T>&)>'],
    [/std::function<void\(Machine&\)>/g,'std::function<Task<void>(Machine&)>'],
    [/std::function<Value\(Machine&, Value\)>/g,'std::function<Task<Value>(Machine&, Value)>'],
    [/std::function<void\(Machine&, Value, const Visit&\)>/g,'std::function<Task<void>(Machine&, Value, const Visit&)>'],
    [/std::function<Value\(Machine&, const Value&, const Value&\)>/g,'std::function<Task<Value>(Machine&, const Value&, const Value&)>'],
    [/std::function<Value\(Machine&, const Value&, const Value&, const Value&\)>/g,'std::function<Task<Value>(Machine&, const Value&, const Value&, const Value&)>'],
    [/std::function<Value\(Value\)>/g,'std::function<Task<Value>(Value)>'],
    [/std::function<Values\(\)>/g,'std::function<Task<Values>()>'],
  ];
  for(const [pattern,replacement] of aliases)for(const m of source.matchAll(pattern))if(codeAt(m.index))edit(m.index,m.index+m[0].length,replacement);
  for(const n of nodes)if(n.async){
    if(n.lambda){
      if(n.arrow!==undefined)edit(tokens[n.arrow+1].a,tokens[n.open].a,`Task<${n.type}> `);
      else edit(tokens[n.open].a,tokens[n.open].a,`${tokens[n.open-1].v===']'?'() ':''}-> Task<${n.type}> `);
    }else{
      const nameIndex=tokens.findIndex((t,i)=>i>=n.start&&i<n.open&&t.v===n.name&&tokens[i+1]?.v==='(');
      const original=raw(n.start,nameIndex),qualifier=original.match(/\b\w+::\s*$/)?.[0]||'',type=original.replace(/^\s*template\s*<[^\n]*?>\s*/,'').replace(/\binline\s+|\[\[noreturn\]\]\s*/g,'').replace(/\b\w+::\s*$/,'').trim();
      const prefix=original.slice(0,original.lastIndexOf(type));
      edit(tokens[n.start].a,tokens[nameIndex].a,`${prefix.replaceAll('[[noreturn]]','')}Task<${type}> ${qualifier}`);
      // Matching declarations, including Machine::perform's member declaration.
      const escaped=n.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const decl=new RegExp(`(?:\\[\\[noreturn\\]\\]\\s*)?(${type.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})\\s+${escaped}\\s*\\([^;{}]*\\)\\s*;`,'g');
      for(const m of source.matchAll(decl))if(codeAt(m.index)&&(m.index<tokens[n.start].a||m.index>tokens[n.end].b)){const start=m.index+m[0].indexOf(m[1]);edit(m.index,start+m[1].length,`Task<${type}>`);}
    }
    if(n.type==='void')edit(tokens[n.end].a,tokens[n.end].a,'co_return;\n');
  }
  for(let i=0;i<tokens.length;i++)if(tokens[i].v==='return'&&owner(i)?.async)edit(tokens[i].a,tokens[i].b,'co_return');
  for(const c of calls)if(suspends(c)){
    edit(tokens[c.start].a,tokens[c.start].a,c.owner.syncContract?'runTask(':'(co_await ');
    edit(tokens[c.end].b,tokens[c.end].b,')');
  }
  // Remove duplicate edits from overloads/declarations; insertions at the same
  // point intentionally nest when both the receiver and its call suspend.
  const seen=new Set();const unique=edits.filter(e=>{const k=JSON.stringify(e);if(seen.has(k))return false;seen.add(k);return true;});
  unique.sort((a,b)=>b.a-a.a||b.b-a.b);
  for(const e of unique)source=source.slice(0,e.a)+e.text+source.slice(e.b);
  const support=readFileSync(new URL('./cpp-coroutines.hpp.txt',import.meta.url),'utf8');
  const task=support.slice(support.indexOf('// Lazy'),support.indexOf('// @runtime CoroutineWorker'));
  const worker=support.slice(support.indexOf('class CoroutineWorker'));
  source=source.replace('using Route =',task+'\nusing Route =').replace('/* COROUTINE_WORKER */',worker);
  source=source.replace('namespace nyanco {','namespace nyanco {\ntemplate <typename T> class Task;');
  if(/^Task<int> main\(\)/m.test(source)){
    source=source.replace(/^Task<int> main\(\)/m,'nyanco::Task<int> coroutineMain()');
    source+='\nint main() { return nyanco::runTask(coroutineMain()); }\n';
  }
  source='#include <coroutine>\n#include <memory_resource>\n#include <type_traits>\n#include <utility>\n'+source;
  source=source.replace(/^#include <(?:thread|mutex|condition_variable)>\r?\n/gm,'');
  return source;
}
