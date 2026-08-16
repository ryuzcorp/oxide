import { echo, ping } from "./test.server";

console.log(await ping());
console.log(await echo("hello"));
