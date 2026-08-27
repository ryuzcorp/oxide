import { Input, LayerCard } from "areia";
import { ilha, state } from "ilha";
import { Greeting } from "$lib/greet.server";
import { head } from "@ilha/router";

export default ilha(() => {
  head({ title: "Home" });
  const name = state("");

  return (
    <div class="mx-auto mt-8 max-w-xl">
      <LayerCard>
        <LayerCard.Title>Greet</LayerCard.Title>
        <LayerCard.Content>
          <label class="flex flex-col gap-1">
            <span>Name</span>
            <Input bind:value={name} name="name" />
          </label>
          <Greeting name={name() || "Ilha"} />
        </LayerCard.Content>
      </LayerCard>
    </div>
  );
});
