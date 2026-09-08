import { Tasks } from "$lib/tasks";
import { head } from "@ilha/router";

export default function Home() {
  head({ title: "Home" });

  return (
    <div class="mx-auto mt-8 flex max-w-xl flex-col gap-4">
      <div class="card bg-base-100 shadow">
        <div class="card-body gap-4">
          <Tasks />
        </div>
      </div>
    </div>
  );
}
