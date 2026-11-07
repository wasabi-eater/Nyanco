// A text view of the serialized typed IR. Value IDs and region IDs are kept
// intact so that this view can be compared directly with --emit-ir JSON.
export function formatTypedIR(program, {backend, noSourcePaths = false} = {}) {
  const types = new Map(program.types.map(t => [t.id,t]));
  const type = id => types.get(id)?.display ?? '?';
  const value = id => `%${id}`;
  const values = ids => `[${ids.map(value).join(', ')}]`;
  const typed = (ids,ts) => ids.map((id,i) => `${value(id)}: ${type(ts[i])}`).join(', ');
  const row = id => id == null || ['empty','bottom'].includes(types.get(id)?.kind) ? '' : type(id);
  const stack = (ids,tail) => `[${[row(tail),...ids.map(value)].filter(Boolean).join(', ')}]`;
  const effect = e => `${e.name}${e.arguments?.length ? ' ' + e.arguments.map(type).join(' ') : ''}${e.target ? '@' + e.target : ''}${e.skip ? ' (skip ' + e.skip + ')' : ''}${e.loans?.length ? ' (loans: ' + e.loans.map(l => l.name ?? l.id).join(', ') + ')' : ''}`;
  const effects = i => {
    const entries = (i.effects || []).map(effect).join(', ');
    const tails = (i.effectTails || []).map(type).join(', ');
    return entries || tails ? ` / {${entries}${tails ? ' | ' + tails : ''}}` : '';
  };
  const literal = data => data.numberSource ?? (typeof data.value === 'string' ? JSON.stringify(data.value) : String(data.value));
  const pattern = p => {
    const fields = (p.fields || []).map(pattern);
    if (p.kind === 'tuple-pattern') return `#(${fields.join(', ')})`;
    if (p.kind === 'list-pattern') return `[${fields.join(', ')}]`;
    if (p.kind === 'record-pattern') return `{${(p.keys || []).map((k,i) => `${k}: ${fields[i]}`).join(', ')}}`;
    if (p.kind === 'concat-pattern') return fields.join(' ++ ');
    if (p.kind === 'or-pattern') return fields.join(' || ');
    if (p.kind === 'literal') return literal(p);
    return `${p.stackMatch ? '~' : p.value ?? p.kind}${fields.length ? '(' + fields.join(', ') + ')' : ''}`;
  };
  const describe = i => {
    const d = i.data || {};
    if (i.op === 'literal') return `literal ${literal(d)}`;
    if (i.op === 'bind') return `bind ${(d.patterns || []).map(pattern).join(', ')}${i.mutable ? ' [mutable]' : ''}`;
    if (i.op === 'update') return `update ${(d.names || [d.name]).join(', ')}`;
    if (i.op === 'list-index') return `${d.sliceMethod || (d.optional ? 'at?' : 'at')}`;
    if (i.op === 'capture') return `capture ${(d.slots || []).map(s => `${s.peek ? '$' : '_'}${s.index}: ${s.peek ? 'peek' : 'pop'}`).join(', ')}`;
    if (i.op === 'reference') return `reference ${d.peek ? '$' : '_'}${d.index}`;
    if (i.op === 'comparison-chain') return `comparison-chain ${(d.operators || []).map(o => o.value ?? o).join(' ')}`;
    if (i.op === 'quote') return `quote${d.labelName ? ' @' + d.labelName : ''}`;
    if (i.op === 'record') return `record {${(d.fields || []).map(f => f.name).join(', ')}}`;
    if (['list','tuple','dict','case','interpolation'].includes(i.op)) return i.op;
    const name = d.sourceName ?? i.name ?? d.name;
    return `${i.op}${name !== undefined ? ' ' + name : ''}`;
  };
  const location = l => {
    if (!l?.line) return '';
    return `${!noSourcePaths && l.file ? l.file + ':' : ''}${l.line}:${l.col ?? 1}`;
  };
  const lines = [`Nyanco typed IR v${program.version}${backend ? ' (' + backend + ')' : ''}`,
    '%N = value; @rN = region; stacks are listed bottom -> top.',
    'move/copy/view/cow = ownership decision; child regions are linked by ID.'];
  for (const r of program.regions) {
    const owner = r.owner;
    const title = owner ? `${owner.kind}${owner.name ? ' ' + owner.name : ''}${owner.site !== undefined ? ' site=' + owner.site : ''}${owner.expression ? ' ' + JSON.stringify(owner.expression) : ''}` : 'body';
    lines.push('',`@r${r.id} ${title}`);
    if (owner?.signature) lines.push(`  specialization: ${owner.signature}`);
    if (owner?.patterns?.length) lines.push(`  parameters: ${owner.patterns.map(pattern).join(', ')}`);
    lines.push(`  inputs: [${[row(r.inputRow),typed(r.inputs,r.inputTypes)].filter(Boolean).join(', ')}]`);
    for (const c of r.captures || []) lines.push(`  capture ${c.name}: ${value(c.external)} -> ${value(c.value)}: ${type(c.type)}`);
    for (const i of r.instructions) {
      const result = i.results.length ? typed(i.results,i.resultTypes) + ' = ' : '';
      const flags = [i.ownership && `${i.ownership.mode}: ${i.ownership.reason}`,
        i.memory?.binding && `RC ${i.memory.binding}: ${i.memory.reason}`,
        i.borrowing && `borrow ${i.borrowing.mode}: ${i.borrowing.reason}`,
        i.loan && `loan ${i.loan.mode}: ${i.loan.owner} -> ${i.loan.reference}`].filter(Boolean);
      const loc = location(i.location);
      const args = i.arguments.length || i.op === 'call' ? `(${i.arguments.map(value).join(', ')})` : '';
      lines.push(`  #${i.id} ${result}${describe(i)}${args}${effects(i)}${flags.length ? ' [' + flags.join('; ') + ']' : ''}${loc ? ' @ ' + loc : ''}`);
      if (i.callType != null) lines.push(`      type: ${type(i.callType)}`);
      lines.push(`      stack: ${values(i.before)} -> ${values(i.after)}`);
      if (i.children?.length) lines.push(`      regions: ${i.children.map(c => `${c.role}[${c.index}] = @r${c.region}`).join(', ')}`);
    }
    lines.push(`  ${r.never ? 'unreachable' : 'return ' + stack(r.outputs,r.outputRow)}`);
  }
  return lines.join('\n') + '\n';
}
