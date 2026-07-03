"use client";

import { useParams } from "next/navigation";

import { SessionView } from "@/components/session/session-view";

// TASK-17 — the session view route, under the (app) group so it inherits the
// workspace gate + sidebar for free. The [name] segment is the session folder
// name (the session's identity until Gemini renames it); Next decodes the route
// param, so it matches the raw folder name scanSessions returns.
//
// Client component: the view reads the workspace handle from context and the
// File System Access API, both browser-only.
export default function SessionPage() {
  const params = useParams<{ name: string }>();

  // Guard the array/undefined shapes useParams can technically return; our route
  // has a single [name] segment, so in practice it's always a string.
  const name = typeof params.name === "string" ? params.name : "";

  return <SessionView name={name} />;
}
