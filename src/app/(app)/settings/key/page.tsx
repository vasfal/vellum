import { PageHeader } from "@/components/page-header";
import { KeySetup } from "@/components/settings/key-setup";

// TASK-29 / S11 — the standalone Gemini-key setup screen. Both the sidebar key
// status (when no key is configured, TASK-38) and the analyze error path (a
// kind:"upload" key failure) link here, so the step-by-step guidance lives in
// exactly one place.
export default function KeySetupPage() {
  return (
    <div className="flex h-svh flex-col">
      <PageHeader title="API key" />
      <main className="flex-1 overflow-y-auto p-6">
        <KeySetup />
      </main>
    </div>
  );
}
