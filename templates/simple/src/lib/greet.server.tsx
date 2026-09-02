export const Greeting = async function Greeting(props: Record<string, unknown>) {
  return <p>Hello, {props.name == null ? "Ilha" : String(props.name)}!</p>;
};
