import { ilha } from "ilha";

export const Greeting = ilha<{ name: String }>(({ name }) => <p>Hello, {name}!</p>);
