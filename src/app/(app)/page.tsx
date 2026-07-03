import { PageHeader } from "@/components/page-header";
import { SessionsEmptyState } from "@/components/sessions-empty-state";
import { RecoveryPrompt } from "@/components/workspace/recovery-prompt";

// Home / nothing-selected screen. The recovery prompt (TASK-24) surfaces here
// when the workspace holds a recording interrupted by a crash; it renders
// nothing when there's nothing to recover, so the empty state (TASK-39) is the
// normal view — the app's first impression, guiding the user to Record or Import.
export default function Home() {
  return (
    <div className="flex h-svh flex-col">
      <PageHeader title="Sessions" />
      <main className="flex flex-1 flex-col p-6">
        <div className="mx-auto w-full max-w-2xl">
          <RecoveryPrompt />
        </div>
        <SessionsEmptyState />
      </main>
    </div>
  );
}
