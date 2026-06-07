import { createAuthenticatedClient } from "../lib/api.js";
import { updateCredentials } from "../lib/credentials.js";
import { log, printJson, renderTable } from "../lib/output.js";

type WorkspaceRow = {
  id: string;
  name: string;
  owner_user_id?: string;
  created_at?: string;
};

type WorkspaceListResponse = {
  workspaces: WorkspaceRow[];
  active_id: string | null;
};

function requireCloudMode(mode: string): void {
  if (mode !== "cloud") {
    throw new Error(
      "Workspaces are a Workeros Cloud feature. Run `floom login --cloud` (or set WORKEROS_CLOUD=1) to switch.",
    );
  }
}

export async function workspacesListCommand(options: { json?: boolean }): Promise<number> {
  const { client, credentials } = await createAuthenticatedClient();
  requireCloudMode(credentials.mode);
  const data = (await client.requestJson("GET", "/api/workspaces")) as WorkspaceListResponse;
  if (options.json) {
    printJson(data);
    return 0;
  }
  const activeId = credentials.workspace_id || data.active_id || "";
  const rows = (data.workspaces || []).map((row) => ({
    Active: row.id === activeId ? "*" : " ",
    Id: row.id,
    Name: row.name,
    Created: row.created_at || "-",
  }));
  process.stdout.write(renderTable(rows, [
    { key: "Active", label: " " },
    { key: "Name", label: "Name" },
    { key: "Id", label: "Id" },
    { key: "Created", label: "Created" },
  ]) + "\n");
  return 0;
}

export async function workspacesShowCommand(options: { json?: boolean }): Promise<number> {
  const { credentials } = await createAuthenticatedClient();
  requireCloudMode(credentials.mode);
  const payload = {
    id: credentials.workspace_id || null,
    name: credentials.workspace_name || null,
    api_base: credentials.api_base,
  };
  if (options.json) {
    printJson(payload);
    return 0;
  }
  if (!payload.id) {
    log.info("No active workspace. Run `floom workspaces list` then `floom workspaces use <name-or-id>`.");
    return 0;
  }
  log.heading("Active workspace");
  log.kv("Name", payload.name || payload.id);
  log.kv("Id", payload.id);
  log.kv("API base", payload.api_base);
  return 0;
}

export async function workspacesUseCommand(target: string): Promise<number> {
  const { client, credentials } = await createAuthenticatedClient();
  requireCloudMode(credentials.mode);
  const data = (await client.requestJson("GET", "/api/workspaces")) as WorkspaceListResponse;
  const needle = target.trim().toLowerCase();
  if (!needle) {
    throw new Error("workspace name or id is required");
  }
  const match = (data.workspaces || []).find(
    (row) =>
      row.id.toLowerCase() === needle ||
      (row.name || "").toLowerCase() === needle,
  );
  if (!match) {
    throw new Error(
      `No workspace matches "${target}". Run \`floom workspaces list\` to see available workspaces.`,
    );
  }
  await updateCredentials({
    workspace_id: match.id,
    workspace_name: match.name,
  });
  log.ok(`Active workspace set to ${match.name} (${match.id}).`);
  return 0;
}
