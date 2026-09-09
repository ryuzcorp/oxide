/* eslint-disable promise/avoid-new, promise/param-names, typescript/no-non-null-assertion -- deferred polyfill for Promise.withResolvers */
interface Deferred<T> {
  promise: Promise<T>;
  reject: (reason?: Error) => void;
  resolve: (value: T | PromiseLike<T>) => void;
}

/** Promise.withResolvers polyfill for Node 20 / older hosts. */
export const deferred = function deferred<T>(): Deferred<T> {
  let resolveFn!: Deferred<T>["resolve"];
  let rejectFn!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return { promise, reject: rejectFn, resolve: resolveFn };
};
