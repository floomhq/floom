import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { createAuthenticatedClient, FloomApiError } from "../lib/api.js";
import { handleAuthError } from "../lib/cli-errors.js";
import { promptYesNo } from "../lib/prompt.js";
import { log, printJson, renderTable } from "../lib/output.js";

// #1741 — headless brain-pack (context) provisioning. The web UI, MCP tools, and
// API already expose the /contexts surface; this gives a script/cron the same
// reach so `workers push` targets that need a context can be set up end-to-end
// without a browser.

type ContextSummary = {
  name: string;
  file_count: number;
  total_size_bytes: number;
  writeable: boolean;
  system?: boolean;
  read_only?: boolean;
  category?: string | null;
  sensitive?: boolean;
};

type SecretWarning = {
  pattern: string;
  line: number;
  masked: string;
};

type ContextFileItem = {
  path: string;
  size: number;
  mime_type: string;
  is_binary: boolean;
  // Set when the pushed content matched a high-confidence secret pattern; the
  // API populates secret_warnings on the write response so operators can move
  // the credential out of the brain pack. See models.ContextFileItem.
  has_secret_warning?: boolean;
  secret_warnings?: SecretWarning[];
};

type ContextDetail = ContextSummary & { files?: ContextFileItem[] };

function notFoundHint(name: string): void {
  log.err(`Context '${name}' not found (or not visible to your credentials).`);
  log.info("List available contexts: floom contexts list");
}

export async function contextsListCommand(options: { json?: boolean } = {}): Promise<number> {
  try {
    const { client } = await createAuthenticatedClient();
    const contexts = (await client.requestJson("GET", "/contexts")) as ContextSummary[];
    if (options.json) {
      printJson(contexts);
      return 0;
    }
    if (!contexts.length) {
      log.info("No contexts yet.");
      log.info("Create one: floom contexts create my-brain-pack");
      return 0;
    }
    process.stdout.write(renderTable(
      contexts.map((ctx) => ({
        Name: ctx.name,
        Files: ctx.file_count,
        Bytes: ctx.total_size_bytes,
        Writeable: ctx.writeable ? "yes" : "no",
        Kind: ctx.system ? "system" : "operator",
      })),
      [
        { key: "Name", label: "Name" },
        { key: "Files", label: "Files" },
        { key: "Bytes", label: "Bytes" },
        { key: "Writeable", label: "Writeable" },
        { key: "Kind", label: "Kind" },
      ],
    ) + "\n");
    return 0;
  } catch (error) {
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}

export async function contextsShowCommand(name: string, options: { json?: boolean } = {}): Promise<number> {
  try {
    const { client } = await createAuthenticatedClient();
    const detail = (await client.requestJson(
      "GET",
      `/contexts/${encodeURIComponent(name)}`,
    )) as ContextDetail;
    if (options.json) {
      printJson(detail);
      return 0;
    }
    log.heading(`Context ${detail.name}`);
    log.kv("Files", String(detail.file_count));
    log.kv("Size", `${detail.total_size_bytes} bytes`);
    log.kv("Writeable", detail.writeable ? "yes" : "no");
    log.kv("Sensitive", detail.sensitive === false ? "no" : "yes");
    if (detail.category) log.kv("Category", detail.category);
    const files = detail.files || [];
    if (files.length) {
      log.blank();
      process.stdout.write(renderTable(
        files.map((f) => ({
          Path: f.path,
          Bytes: f.size,
          Type: f.is_binary ? "binary" : "text",
        })),
        [
          { key: "Path", label: "Path" },
          { key: "Bytes", label: "Bytes" },
          { key: "Type", label: "Type" },
        ],
      ) + "\n");
    }
    return 0;
  } catch (error) {
    if (error instanceof FloomApiError && error.status === 404) {
      notFoundHint(name);
      return 1;
    }
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}

export async function contextsCreateCommand(
  name: string,
  options: { writeable?: boolean; sensitive?: boolean; category?: string; json?: boolean } = {},
): Promise<number> {
  const trimmed = name.trim();
  if (!trimmed) {
    log.err("context name is required");
    return 1;
  }
  try {
    const { client } = await createAuthenticatedClient();
    const body: Record<string, unknown> = {
      writeable: Boolean(options.writeable),
      // Sensitive (no git versioning) is the server default; honor --no-sensitive.
      sensitive: options.sensitive !== false,
    };
    if (options.category) body.category = options.category;
    const created = (await client.requestJson(
      "POST",
      `/contexts/${encodeURIComponent(trimmed)}`,
      { body },
    )) as ContextDetail;
    if (options.json) {
      printJson(created);
      return 0;
    }
    log.ok(`Created context ${created.name}.`);
    log.step("Add files: floom contexts push " + created.name + " <path-in-context> <local-file>");
    return 0;
  } catch (error) {
    if (error instanceof FloomApiError && error.status === 409) {
      log.err(`Context '${trimmed}' already exists.`);
      log.info("Inspect it: floom contexts show " + trimmed);
      return 1;
    }
    if (error instanceof FloomApiError && error.status === 400) {
      log.err(`Invalid context name '${trimmed}': ${error.body && typeof error.body === "object" && "detail" in error.body ? String((error.body as { detail: unknown }).detail) : error.message}`);
      return 1;
    }
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}

export async function contextsPushCommand(
  name: string,
  contextPath: string,
  localFile: string,
  options: { json?: boolean } = {},
): Promise<number> {
  const cleanPath = contextPath.trim();
  if (!cleanPath) {
    log.err("destination path inside the context is required");
    return 1;
  }
  try {
    const bytes = await readFile(localFile);
    const { client } = await createAuthenticatedClient();
    // The endpoint writes the raw request body verbatim when the content-type
    // is not application/json, so bytes round-trip for both text and binary.
    const encodedPath = cleanPath.split("/").map(encodeURIComponent).join("/");
    const result = (await client.requestJson(
      "PUT",
      `/contexts/${encodeURIComponent(name)}/files/${encodedPath}`,
      { rawBody: new Uint8Array(bytes) },
    )) as ContextFileItem;
    if (options.json) {
      printJson(result);
      return 0;
    }
    log.ok(`Pushed ${cleanPath} to context ${name} (${result.size} bytes).`);
    // Surface secret-detection findings the API returns on the write response.
    // Without this the default (non-JSON) path silently hides the only warning
    // that a credential leaked into the brain pack.
    if (result.has_secret_warning) {
      const warnings = result.secret_warnings ?? [];
      log.warn(`${cleanPath} contains ${warnings.length || "a"} possible secret${warnings.length === 1 ? "" : "s"}. Move credentials to Secrets instead of the brain pack.`);
      for (const w of warnings) {
        log.warn(`  line ${w.line}: ${w.pattern} (${w.masked})`);
      }
    }
    return 0;
  } catch (error) {
    if (error instanceof FloomApiError && error.status === 404) {
      notFoundHint(name);
      return 1;
    }
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
      log.err(`Local file not found: ${localFile}`);
      return 1;
    }
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}

export async function contextsPullCommand(
  name: string,
  contextPath: string,
  options: { output?: string } = {},
): Promise<number> {
  const cleanPath = contextPath.trim();
  if (!cleanPath) {
    log.err("path inside the context is required");
    return 1;
  }
  try {
    const { client } = await createAuthenticatedClient();
    const encodedPath = cleanPath.split("/").map(encodeURIComponent).join("/");
    const bytes = await client.requestBuffer(
      "GET",
      `/contexts/${encodeURIComponent(name)}/files/${encodedPath}`,
    );
    const dest = options.output || basename(cleanPath);
    await writeFile(dest, bytes);
    log.ok(`Saved ${name}/${cleanPath} to ${dest} (${bytes.byteLength} bytes).`);
    return 0;
  } catch (error) {
    if (error instanceof FloomApiError && error.status === 404) {
      log.err(`File '${cleanPath}' not found in context '${name}'.`);
      log.info("List files: floom contexts show " + name);
      return 1;
    }
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}

export async function contextsDeleteCommand(
  name: string,
  options: { yes?: boolean } = {},
): Promise<number> {
  try {
    const confirmed = options.yes || await promptYesNo(`Delete context ${name}? [y/N] `, false);
    if (!confirmed) {
      log.info("Cancelled.");
      return 0;
    }
    const { client } = await createAuthenticatedClient();
    await client.requestJson("DELETE", `/contexts/${encodeURIComponent(name)}`);
    log.ok(`Deleted context ${name}.`);
    return 0;
  } catch (error) {
    if (error instanceof FloomApiError && error.status === 404) {
      notFoundHint(name);
      return 1;
    }
    if (error instanceof FloomApiError && error.status === 409) {
      log.err(`Context '${name}' is in use and cannot be deleted.`);
      const detail = error.body && typeof error.body === "object" && "detail" in error.body
        ? (error.body as { detail: unknown }).detail
        : null;
      if (detail) log.info(typeof detail === "string" ? detail : JSON.stringify(detail));
      return 1;
    }
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}
