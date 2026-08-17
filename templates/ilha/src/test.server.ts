export async function ping() {
  return "pong" as const;
}

export async function echo(value: string) {
  return value;
}

export async function* ticks() {
  yield 0;
  yield 1;
}
