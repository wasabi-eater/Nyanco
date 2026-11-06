// Persistent two-stack deque; heap uses an array with binary-heap ordering.
const node=(value,next)=>({value,next});
const reverse=list=>{let out=null;for(;list;list=list.next)out=node(list.value,out);return out;};
export const emptyDeque=()=>({kind:'deque',front:null,back:null,size:0});
export function queuePush(q,value,front=false){return {...q,[front?'front':'back']:node(value,q[front?'front':'back']),size:q.size+1};}
export function queuePop(q,back=false){
 const side=back?'back':'front',other=back?'front':'back';
 if(!q.size)return [q,undefined,false];
 if(!q[side])q={...q,[side]:reverse(q[other]),[other]:null};
 return [{...q,[side]:q[side].next,size:q.size-1},q[side].value,true];
}
export function collectionItems(c){
 if(c.kind==='heap')return c.items;
 const xs=[],ys=[];for(let n=c.front;n;n=n.next)xs.push(n.value);for(let n=c.back;n;n=n.next)ys.push(n.value);return xs.concat(ys.reverse());
}
export function* heapPush(h,value,less){
 const items=[...h.items,value];let i=items.length-1;
 while(i){const parent=(i-1)>>1;if(!(yield* less(items[parent],items[i])))break;[items[parent],items[i]]=[items[i],items[parent]];i=parent;}
 return {kind:'heap',items};
}
export function* heapPop(h,less){
 if(!h.items.length)return [h,undefined,false];
 const items=h.items.slice(),value=items[0],last=items.pop();if(items.length)items[0]=last;
 for(let i=0;i*2+1<items.length;){let child=i*2+1;if(child+1<items.length&&(yield* less(items[child],items[child+1])))child++;if(!(yield* less(items[i],items[child])))break;[items[i],items[child]]=[items[child],items[i]];i=child;}
 return [{kind:'heap',items},value,true];
}
export const collectionOperations={
 __emptyDeque:0,qpush:2,qpushFront:2,qpop:1,qpopBack:1,qpeek:1,qpeekBack:1,qlength:1,qisEmpty:1,
 __emptyHeap:0,hpush:2,hpop:1,hpeek:1,hlength:1,hisEmpty:1,
};
