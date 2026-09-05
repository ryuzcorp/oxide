interface AsyncGenerator<
  T = unknown,
  TReturn = unknown,
  TNext = unknown,
> extends AsyncIteratorObject<T, TReturn, TNext> {
  then: <TResult1 = AsyncIterable<T>, TResult2 = never>(
    onfulfilled?:
      | ((value: AsyncIterable<T>) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?:
      | ((
          reason: Error | string | number | boolean | null | undefined
        ) => TResult2 | PromiseLike<TResult2>)
      | null
  ) => Promise<TResult1 | TResult2>;
}
