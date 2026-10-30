import {lex} from '../language.mjs';
export function numericTokens(tree,source,file){
 const literals=new Map(lex(source,file).filter(t=>typeof t.value==='number').map(t=>[t.line+':'+t.col,t])),seen=new Set();
 const visit=v=>{if(!v||typeof v!=='object'||seen.has(v))return;seen.add(v);if(v.kind==='literal'&&typeof v.value==='number'){const t=literals.get(v.line+':'+v.col);if(t){v.numericKind=t.numericKind;v.numberSource=t.numberSource;}}for(const x of v instanceof Map?v.values():Object.values(v))visit(x);};visit(tree);for(const v of Object.values(tree))visit(v);return tree;
}
export function legacyValues(v){if(v?.kind==='scalar'&&v.type==='float')return v.value;if(Array.isArray(v))return v.map(legacyValues);if(v?.kind==='tuple')return {...v,items:v.items.map(legacyValues)};if(v?.kind==='adt')return {...v,fields:v.fields.map(legacyValues)};return v;}
