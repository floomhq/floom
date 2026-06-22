import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { createAuthenticatedClient } from "../lib/api.js";
import { handleAuthError } from "../lib/cli-errors.js";
import { log, printJson, renderTable } from "../lib/output.js";

type ContextSummary = {
  name: string;
  description?: string | null;
  file_count?: number;
  writeable?: boolean;
  sensitive?: boolean;
  visibility?: string;
  category?: string | null;
  updated_at?: string | null;
};

type ContextFile = {
  path?: string;
  content?: string;
  is_binary?: boolean;
  mime_type?: string;
  size?: number;
  download_url?: string;
  note?: string;
};

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function contextPath(name: string): string {
  return `/contexts/${encodeURIComponent(name.trim())}`;
}

function filePath(name: string, path: string): string {
  return `${contextPath(name)}/files/${encodePath(path.trim())}`;
}

function requireValue(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

export async function contextsListCommand(options: { json?: boolean }): Promise<number> {
  try {
    const { client } = await createAuthenticatedClient();
    const contexts = (await client.requestJson("GET", "/contexts")) as ContextSummary[];
    if (options.json) {
      printJson(contexts);
      return 0;
    }
    if (!contexts.length) {
      log.info("No brain packs found.");
      return 0;
    }
    process.stdout.write(renderTable(
      contexts.map((ctx) => ({
        Name: ctx.name,
        Files: ctx.file_count ?? 0,
        Writeable: ctx.writeable ? "yes" : "no",
        Sensitive: ctx.sensitive === false ? "no" : "yes",
        Visibility: ctx.visibility || "-",
        Updated: ctx.updated_at || "-",
      })),
      [
        { key: "Name", label: "Name" },
        { key: "Files", label: "Files" },
        { key: "Writeable", label: "Writeable" },
        { key: "Sensitive", label: "Sensitive" },
        { key: "Visibility", label: "Visibility" },
        { key: "Updated", label: "Updated" },
      ],
    ) + "\n");
    return 0;
  } catch (error) {
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}

export async function contextsCreateCommand(
  name: string,
  options: { writeable?: boolean; sensitive?: boolean; json?: boolean },
): Promise<number> {
  try {
    const safeName = requireValue(name, "context name");
    const { client } = await createAuthenticatedClient();
    const created = await client.requestJson("POST", contextPath(safeName), {
      body: {
        writeable: Boolean(options.writeable),
        sensitive: options.sensitive !== false,
      },
    });
    if (options.json) printJson(created);
    else log.ok(`Created brain pack ${safeName}.`);
    return 0;
  } catch (error) {
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}

export async function contextsReadCommand(
  name: string,
  path: string,
  options: { json?: boolean },
): Promise<number> {
  try {
    const { client } = await createAuthenticatedClient();
    const file = (await client.requestJson("GET", filePath(
      requireValue(name, "context name"),
      requireValue(path, "file path"),
    ))) as ContextFile;
    if (options.json) {
      printJson(file);
    } else if (typeof file.content === "string" && !file.is_binary) {
      process.stdout.write(file.content);
      if (!file.content.endsWith("\n")) process.stdout.write("\n");
    } else {
      log.info(file.note || "Binary file.");
      if (file.download_url) log.kv("Download", file.download_url);
      if (file.mime_type) log.kv("Type", file.mime_type);
      if (file.size !== undefined) log.kv("Size", String(file.size));
    }
    return 0;
  } catch (error) {
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}

export async function contextsWriteCommand(
  name: string,
  path: string,
  options: { content?: string; file?: string; json?: boolean },
): Promise<number> {
  try {
    const safeName = requireValue(name, "context name");
    const safePath = requireValue(path, "file path");
    if (options.content === undefined && !options.file) {
      log.err("Provide --content or --file.");
      return 1;
    }
    const content = options.file
      ? await readFile(options.file, "utf8")
      : String(options.content ?? "");
    const { client } = await createAuthenticatedClient();
    const written = await client.requestJson("PUT", filePath(safeName, safePath), {
      body: { content },
    });
    if (options.json) printJson(written);
    else log.ok(`Wrote ${safeName}/${safePath}.`);
    return 0;
  } catch (error) {
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}

export async function contextsUploadCommand(
  name: string,
  file: string,
  options: { path?: string; json?: boolean },
): Promise<number> {
  try {
    const safeName = requireValue(name, "context name");
    const targetPath = requireValue(options.path || basename(file), "file path");
    const { client } = await createAuthenticatedClient();
    const parsed = await client.uploadContextFile(safeName, file, targetPath);
    if (options.json) printJson(parsed);
    else log.ok(`Uploaded ${targetPath} to ${safeName}.`);
    return 0;
  } catch (error) {
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}

export async function contextsDeleteCommand(name: string, options: { force?: boolean; json?: boolean }): Promise<number> {
  try {
    const safeName = requireValue(name, "context name");
    const { client } = await createAuthenticatedClient();
    const deleted = await client.requestJson("DELETE", contextPath(safeName), {
      query: options.force ? { force: true } : undefined,
    });
    if (options.json) printJson(deleted);
    else log.ok(`Deleted brain pack ${safeName}.`);
    return 0;
  } catch (error) {
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}

export async function contextsDeleteFileCommand(name: string, path: string, options: { json?: boolean }): Promise<number> {
  try {
    const safeName = requireValue(name, "context name");
    const safePath = requireValue(path, "file path");
    const { client } = await createAuthenticatedClient();
    const result = await client.requestJson("DELETE", filePath(safeName, safePath));
    if (options.json) printJson(result);
    else log.ok(`Deleted ${safeName}/${safePath}.`);
    return 0;
  } catch (error) {
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}

export async function contextsVersionsCommand(name: string, options: { limit?: number; json?: boolean }): Promise<number> {
  try {
    const safeName = requireValue(name, "context name");
    const { client } = await createAuthenticatedClient();
    const versions = await client.requestJson("GET", `${contextPath(safeName)}/versions`, {
      query: { limit: options.limit ?? 50 },
    });
    if (options.json) {
      printJson(versions);
      return 0;
    }
    const rows = Array.isArray(versions) ? versions.map((row) => ({
      Sha: row?.sha || row?.version_id || "-",
      Message: row?.message || "-",
      Author: row?.author || row?.author_name || "-",
      Date: row?.date || row?.created_at || "-",
    })) : [];
    process.stdout.write(renderTable(rows, [
      { key: "Sha", label: "Sha" },
      { key: "Message", label: "Message" },
      { key: "Author", label: "Author" },
      { key: "Date", label: "Date" },
    ]) + "\n");
    return 0;
  } catch (error) {
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}

export async function contextsRollbackCommand(name: string, versionId: string, options: { json?: boolean }): Promise<number> {
  try {
    const safeName = requireValue(name, "context name");
    const safeVersion = requireValue(versionId, "version id");
    const { client } = await createAuthenticatedClient();
    const result = await client.requestJson("POST", `${contextPath(safeName)}/rollback/${encodeURIComponent(safeVersion)}`);
    if (options.json) printJson(result);
    else log.ok(`Rolled back ${safeName} to ${safeVersion}.`);
    return 0;
  } catch (error) {
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}
