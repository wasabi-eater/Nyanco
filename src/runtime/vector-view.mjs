const shared = new WeakSet();
const views = new WeakMap();
const indexOf = key => typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) ? Number(key) : -1;

export const canMutateVector = value => !shared.has(value) && !views.has(value);

// Array-compatible, read-only storage sharing. Updates materialize an ordinary
// array through canMutateVector, so a view never observes later writes.
export function vectorView(source, start, count) {
  const parent = views.get(source);
  if (parent) { start += parent.start; source = parent.source; }
  shared.add(source);
  const target = [];
  const view = new Proxy(target, {
    get(array, key, receiver) {
      if (key === 'length') return count;
      const index = indexOf(key);
      return index >= 0 ? index < count ? source[start + index] : undefined : Reflect.get(array, key, receiver);
    },
    has(array, key) {
      const index = indexOf(key);
      return index >= 0 ? index < count : Reflect.has(array, key);
    },
    ownKeys() { return [...Array.from({length:count}, (_,i) => String(i)), 'length']; },
    getOwnPropertyDescriptor(array, key) {
      if (key === 'length') return {value:count,writable:true,enumerable:false,configurable:false};
      const index = indexOf(key);
      return index >= 0 && index < count
        ? {value:source[start + index],writable:false,enumerable:true,configurable:true}
        : Reflect.getOwnPropertyDescriptor(array, key);
    },
    set() { throw new Error('Vector views must be copied before mutation'); },
  });
  views.set(view,{source,start,count});
  return view;
}
