/* eslint-disable func-names -- Ilha island scanner requires `= function`, not an arrow */
interface GreetingProps {
  name?: string | number | boolean | null;
}

// Ilha islands: `export const X = function …` (arrows are not scanned).
export const Greeting = function (props: GreetingProps) {
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
