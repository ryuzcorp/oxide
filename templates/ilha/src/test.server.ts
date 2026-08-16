export async function ping() {
  return "pong" as const;
}

export async function echo(value: string) {
  return value;
}
