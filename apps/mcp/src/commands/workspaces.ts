import { createAuthenticatedClient, FloomApiError, type FloomApiClient } from "../lib/api.js";
import { handleAuthError } from "../lib/cli-errors.js";
import { updateCredentials, type StoredCredentials } from "../lib/credentials.js";
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

// OSS serves GET /workspaces; in hosted mode the client rewrites the path to
// /api/workspaces. Both return { workspaces, active_id }.
async function fetchWorkspaces(client: FloomApiClient): Promise<WorkspaceListResponse> {
  try {
    return (await client.requestJson("GET", "/workspaces")) as WorkspaceListResponse;
  } catch (error) {
    if (error instanceof FloomApiError && error.status === 404) {
      throw new Error(
        "This Floom server does not support workspaces. Update the server to a version with local workspaces.",
      );
    }
    throw error;
  }
}

function activeWorkspaceId(credentials: StoredCredentials, data: WorkspaceListResponse): string {
  return credentials.workspace_id || data.active_id || "";
}

export async function workspacesListCommand(options: { json?: boolean }): Promise<number> {
  try {
    const { client, credentials } = await createAuthenticatedClient();
    const data = await fetchWorkspaces(client);
    if (options.json) {
      printJson(data);
      return 0;
    }
    const activeId = activeWorkspaceId(credentials, data);
    const rows = (data.workspaces || []).map((row) => ({
      Active: row.id === activeId ? "*" : " ",
      Id: row.id,
      Name: row.name,
      // Every workspace the API returns is reachable with the stored token;
      // inaccessible workspaces are not listed at all.
      Auth: "authenticated",
      Created: row.created_at || "-",
    }));
    process.stdout.write(renderTable(rows, [
      { key: "Active", label: " " },
      { key: "Name", label: "Name" },
      { key: "Id", label: "Id" },
      { key: "Auth", label: "Auth" },
      { key: "Created", label: "Created" },
    ]) + "\n");
    log.step("Only workspaces your credentials can access are listed.");
    return 0;
  } catch (error) {
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}

export async function workspacesCreateCommand(name: string, options: { json?: boolean } = {}): Promise<number> {
  try {
    const trimmed = name.trim();
    if (!trimmed) {
      log.err("workspace name is required");
      return 1;
    }
    const { client } = await createAuthenticatedClient();
    const created = (await client.requestJson("POST", "/workspaces", {
      body: { name: trimmed },
    })) as WorkspaceRow;
    await updateCredentials({
      workspace_id: created.id,
      workspace_name: created.name,
    });
    if (options.json) {
      printJson(created);
    } else {
      log.ok(`Created workspace ${created.name} (${created.id}).`);
      log.step("Active workspace updated for future CLI and MCP requests.");
    }
    return 0;
  } catch (error) {
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}

export async function workspacesShowCommand(options: { json?: boolean }): Promise<number> {
  try {
    const { credentials } = await createAuthenticatedClient();
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
      log.info("No active workspace. Run `floom workspaces list` then `floom workspaces switch <name-or-id>`.");
      return 0;
    }
    log.heading("Active workspace");
    log.kv("Name", payload.name || payload.id);
    log.kv("Id", payload.id);
    log.kv("API base", payload.api_base);
    return 0;
  } catch (error) {
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}

export async function workspacesSwitchCommand(target: string): Promise<number> {
  try {
    const { client, credentials } = await createAuthenticatedClient();
    const needle = target.trim().toLowerCase();
    if (!needle) {
      log.err("workspace name or id is required");
      return 1;
    }
    const data = await fetchWorkspaces(client);
    const match = (data.workspaces || []).find(
      (row) =>
        row.id.toLowerCase() === needle ||
        (row.name || "").toLowerCase() === needle,
    );
    if (!match) {
      log.err(`No authenticated workspace matches "${target}".`);
      process.stderr.write(
        "Run `floom workspaces list` to see workspaces your credentials can access.\n" +
        "If the workspace belongs to another account, authenticate first: floom login" +
        (credentials.mode === "cloud" ? " --cloud" : "") + "\n",
      );
      return 1;
    }
    if (credentials.mode === "oss") {
      // Server-side validation: OSS silently falls back to the default
      // workspace on unknown ids, so confirm the selection explicitly.
      try {
        await client.requestJson("POST", `/workspaces/${match.id}/select`);
      } catch (error) {
        if (error instanceof FloomApiError && error.status === 404) {
          log.err(`Workspace ${match.id} was not accepted by the server.`);
          process.stderr.write("Re-run `floom workspaces list` and try again.\n");
          return 1;
        }
        throw error;
      }
    }
    await updateCredentials({
      workspace_id: match.id,
      workspace_name: match.name,
    });
    log.ok(`Active workspace set to ${match.name} (${match.id}).`);
    log.step("Installed MCP client configs pin the workspace at install time. Re-run `floom mcp install` to repoint them.");
    return 0;
  } catch (error) {
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}
