declare module "virtual:oxide/actions" {
  // Generated tacho router. Typed loosely so apps can pass it to handle().
  const actions: Record<string, never>;
  export default actions;
  export { actions };
}

declare module "virtual:oxide/client" {
  export const client: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;
}
