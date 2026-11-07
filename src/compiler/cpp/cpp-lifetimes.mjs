import {typeIR} from '../../types/types.mjs';

// Lexical lifetimes for the C++ RC backend. Bindings, rather than spellings,
// distinguish shadowed names. A write ends the old generation of a mutable
// binding; quotation captures are uses and are protected by shared Cell RC.
export function cppLifetimes(nodes, trace, {parameters = [], local = true} = {}) {
  const takes = new WeakSet(), captures = new WeakMap(), external = new Map();
  const initial = new Map(parameters.map(name => [name,{name,owned:local}]));
  function unit(body, inherited, own = local, keepInherited = true) {
    const events = [], created = new Set(), used = new Set();
    const read = (binding,node) => {
      if (!binding) return;
      used.add(binding); events.push({reads:[binding],node});
    };
    const lookup = (name,scope,info) => {
      if (scope.has(name)) return scope.get(name);
      if (!info?.env?.has(name)) return null;
      if (!external.has(name)) external.set(name,{name,owned:false});
      return external.get(name);
    };
    const nested = (child,scope,node,extra = []) => {
      const names = unit(child,new Map(scope));
      const reads = new Set([...names,...extra].filter(Boolean));
      for (const binding of reads) used.add(binding);
      events.push({reads:[...reads]});
      if (node) captures.set(node,[...reads].map(b => b.name));
    };
    const walk = (parts,scope) => {
      for (const n of parts) {
        const info = trace.get(n);
        if (!info) break;
        for (const name of [n.target,n.handlerLabel].filter(Boolean)) read(lookup(name,scope,info));
        if (n.kind === 'application') { walk(info.application,scope); continue; }
        if (n.kind === 'scope') { walk(n.body,new Map(scope)); continue; }
        if (n.kind === 'word') { read(lookup(n.value,scope,info),n); continue; }
        if (n.kind === 'bind') {
          for (const name of n.names) {
            const binding = {name,owned:own};
            created.add(binding); scope.set(name,binding);
          }
          continue;
        }
        if (n.kind === 'update') {
          walk(n.body,new Map(scope));
          const writes = (n.names || [n.name]).map(name => lookup(name,scope,info)).filter(Boolean);
          writes.forEach(binding => used.add(binding));
          const effects = typeIR.effectDescription(info.updateEffects);
          // An effect can abandon this update before it commits. Keep the
          // previous cell contents available until the replacement is ready.
          if (typeIR.isBottom(info.output) || effects.entries.length || effects.tails.length)
            events.push({reads:writes});
          else events.push({writes});
          continue;
        }
        if (n.kind === 'quote' || n.kind === 'local-function') {
          nested(n.body,scope,n);
          if (n.kind === 'local-function') {
            const binding = {name:n.name,owned:own};
            created.add(binding); scope.set(n.name,binding);
          }
          continue;
        }
        if (n.kind === 'case') {
          for (const b of n.branches) {
            const branch = new Map(scope);
            const hide = ps => { for (const p of ps || []) {
              if (p.kind === 'word') branch.set(p.value,{name:p.value,owned:false});
              hide(p.fields);
            }};
            hide(b.patterns);
            nested([...(b.guard || []),...b.body],branch);
          }
          continue;
        }
        if (n.kind === 'borrow' || n.kind === 'mask' || n.kind === 'label') {
          nested(n.body,scope,null,n.kind === 'borrow' ? [lookup(n.owner,scope,info)] : []);
          continue;
        }
        if (n.kind === 'binary' && ['&&','||'].includes(n.value)) {
          walk(n.left,new Map(scope)); nested(n.right,scope); continue;
        }
        if (n.kind === 'comparison-chain') {
          walk(n.operands[0],new Map(scope));
          for (const operand of n.operands.slice(1)) nested(operand,scope);
          continue;
        }
        // Operands and literal bodies run now. A quotation's separate unit
        // above prevents a last textual use in a loop from consuming a capture.
        if (n.body) walk(n.body,new Map(scope));
        for (const f of n.fields || []) if (f.body) walk(f.body,new Map(scope));
        for (const operand of n.operands || []) walk(operand,new Map(scope));
        if (n.left) walk(n.left,new Map(scope));
        if (n.right) walk(n.right,new Map(scope));
      }
    };
    walk(body,new Map(inherited));
    const live = new Set();
    // External bindings remain available to the caller after this unit. A
    // local mutable write can still kill their old generation, but Env::take
    // will refuse extraction whenever another scope/closure shares the cell.
    if (keepInherited) for (const binding of inherited.values()) live.add(binding);
    for (let i=events.length-1;i>=0;i--) {
      const e = events[i];
      for (const binding of e.writes || []) live.delete(binding);
      for (const binding of e.reads || []) {
        if (e.node && binding.owned && !live.has(binding)) takes.add(e.node);
        live.add(binding);
      }
    }
    return new Set([...used].filter(binding => !created.has(binding)));
  }
  // Parameters belong to this invocation, unlike captures of nested units.
  const bodyInitial = new Map(initial);
  for (const binding of initial.values()) binding.owned = local;
  unit(nodes,bodyInitial,local,false);
  return {takes,captures};
}
