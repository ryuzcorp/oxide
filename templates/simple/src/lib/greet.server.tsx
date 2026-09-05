interface GreetingProps {
  name?: string | number | boolean | null;
}

export const Greeting = function Greeting(props: GreetingProps) {
  return (
    <p>
      Hello,{" "}
      {props.name === undefined || props.name === null
        ? "Ilha"
        : String(props.name)}
      !
    </p>
  );
};
