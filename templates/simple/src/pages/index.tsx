import { Greeting } from "$lib/greet.server";
import { head } from "@ilha/router";
import { atom } from "ilha";

export default function Home() {
  head({ title: "Home" });
  const name = atom("");

  return (
    <div class="card bg-base-100 mx-auto mt-8 max-w-xl shadow">
      <div class="card-body gap-4">
        <h2 class="card-title">Greet</h2>
        <label class="flex flex-col gap-1">
          <span>Name</span>
          <input
            class="input input-bordered"
            name="name"
            value={name()}
            oninput={(event: Event) => {
              const target = event.currentTarget;
              if (target instanceof HTMLInputElement) {
                name.set(target.value);
              }
            }}
          />
        </label>
        <Greeting name={name() || "Ilha"} />
      </div>
    </div>
  );
}
