export const Greeting = async function Greeting(props: Record<string, unknown>) {
  return <p>Hello, {String(props.name) || "Ilha"}!</p>;
};
