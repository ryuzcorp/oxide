import { DemoWorkflowPanel } from "$lib/demo-workflow";
import { FilesPanel } from "$lib/files";
import { Tasks } from "$lib/tasks";
import { head } from "@ilha/router";

export default function Home() {
  head({ title: "Tasks" });

  return (
    <div class="mx-auto mt-8 flex max-w-xl flex-col gap-4">
      <div class="card bg-base-100 shadow">
        <div class="card-body gap-4">
          <Tasks />
        </div>
      </div>
      <div class="card bg-base-100 shadow">
        <div class="card-body gap-4">
          <FilesPanel />
        </div>
      </div>
      <div class="card bg-base-100 shadow">
        <div class="card-body gap-4">
          <DemoWorkflowPanel />
        </div>
      </div>
    </div>
  );
}
