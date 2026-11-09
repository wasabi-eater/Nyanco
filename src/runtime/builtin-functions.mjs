import {installUnwrap,installOrElse,installContainerFunctions,isStandardResult} from './builtin-results.mjs';
import {isStandardOption} from './builtin-option.mjs';
import {worklistOperations} from './builtin-effects.mjs';
import {installOperatorClasses} from '../types/operator-classes.mjs';
import {parseExpression} from '../frontend/language.mjs';
// Ordinary functions retain stack/effect polymorphism and use the same lowering.
export function withStandardFunctions(definitions){
 const result=Object.assign(new Map(definitions),definitions),token={file:'<standard>',line:1,col:1};
 const add=(name,parameters,body,signature)=>{if(result.has(name))return;
  const clauses=[{patterns:parameters.map(value=>({...token,kind:'word',value})),body:parseExpression(body,'<standard>',definitions.constructors),token:{...token,value:name}}];if(signature)clauses.signature=signature;result.set(name,clauses);
 };
 installUnwrap(result,add);
 if(!result.classes.has('or')){const classes=new Map(result.classes),methods=new Map(result.methods);installOperatorClasses(classes,methods);result.classes.set('or',classes.get('or'));result.methods.set('.|.',methods.get('.|.'));}
 installOrElse(result,add);installContainerFunctions(result,add);
 // Conversion classes keep their toX names; their methods name the target type.
 // The old function names remain ordinary compatibility aliases.
 for(const type of ['int','float','byte','char'])add('to'+type[0].toUpperCase()+type.slice(1),[],type);
 for(const type of ['vector','dict','set','deque','heap'])add('to'+type[0].toUpperCase()+type.slice(1),[],type);
 add('repeat',['value'],'fromYield {while {True} {yield value}}');
 add('repeatWith',['next'],'fromYield {while {True} {call next; yield}}');
 add('count',[],'fold 0 {drop; + 1}');
 add('sum',[],'fold (fromInt 0) {+}');
 add('product',[],'fold (fromInt 1) {*}');
 add('zipWith',['left','right','f'],'map (zip left right) {-> #(a, b); call a b f}');
 add('unzip',['xs'],'pairs <- vector xs; vmap pairs {-> #(a, _); a}, vmap pairs {-> #(_, b); b}');
 add('__tc_updateAt',['xs','i','f'],'xs with {[i] ! call f}');
 add('__tc_tryUpdateAt',['xs','i','f'],'xs with {?[i] ! call f}');
 // The search helpers require a vector even though length is overloaded.
 add('__tc_vectorLength',[],'length',"['a] -> int / {}");
 if(isStandardOption(result))add('tryAt',['xs','i'],'xs.?[i]');
 // Helpers that pattern-match standard ADTs must wait until constructors are
 // registered, and must not assume a user-defined option/result has that shape.
 if(isStandardOption(result))add('partitionPoint',['xs','predicate'],`mut lo <- 0
mut hi <- __tc_vectorLength xs
while {lo < hi} {
    mid <- lo + (hi - lo) / 2
    xs.?[mid]; case
        -> Some item ? call item predicate
        -> None ? False
    end
    if {lo <<- mid + 1} {hi <<- mid}
}
lo`);
 if(isStandardOption(result)&&isStandardResult(result)){
 add('binarySearchBy',['xs','key','project'],`position <- partitionPoint xs {call _ project; < key}
xs.?[position]; case
    -> Some item ? if (call item project; == key) {Ok position} {Err position}
    -> None ? Err position`);
 add('binarySearch',['xs','key'],'binarySearchBy xs key {nop}');
 }
 add('countIf',[],'filter, count');
 add('countsBy',[],'map, counts');
 add('orderedCounts',[],`sort -> items
if (length items == 0) {[]} do
    mut key <- head items
    mut occurrences <- 0
    mut groups <- []
    each items do -> item
        if (item == key) {occurrences ! + 1} do
            groups ! vpush #(key, occurrences)
            key <<- item
            occurrences <<- 1
    vpush groups #(key, occurrences)`);
 add('deque',['xs'],'fold xs __emptyDeque {qpush}');
 add('heap',['xs'],'fold xs __emptyHeap {hpush}');
 if(isStandardOption(result)){
  const handleWorklist = (push,pop,peek)=>`mut pending <- initial
handle body {
    ${worklistOperations.push}: {-> item k; pending ! ${push} item; resume k},
    ${worklistOperations.pop}: {-> k; pending ! ${pop}; -> item; resume item k},
    ${worklistOperations.peek}: {-> k; resume (${peek} pending) k}
}`;
  add('withHeap',['initial','body'],handleWorklist('hpush','hpop','hpeek'));
  add('withDeque',['initial','body'],handleWorklist('qpush','qpopFront','qpeek'));
 }
 add('set',['xs'],'fold xs __emptySet {sinsert}');
 add('sunion',['xs','ys'],'fold ys xs {sinsert}');
 add('sintersection',['xs','ys'],'filter xs {scontains ys _}; set');
 add('sdifference',['xs','ys'],'filter xs {scontains ys _; not}; set');
 add('loop',[],'while {True} _');
 // The outer loop also catches break during initialization. The inner loop
 // ends on break/cancel in cont; the final cancel prevents initialization restarting.
 add('iterate',['start','cont'],'fromYield {while {True} {call start; while {True} {yield $; call cont}; cancel}}');
 return result;
}
