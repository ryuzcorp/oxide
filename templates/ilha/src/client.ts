import { echo, ping, ticks } from "./test.server";

console.log(await ping());
console.log(await echo("hello"));

for await (const n of await ticks()) {
  console.log(n);
}
