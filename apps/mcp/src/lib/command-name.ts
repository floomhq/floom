import { basename } from "node:path";

export type CommandName = "workeros" | "floom";

// Name of the binary the user actually invoked, captured once by main() so
// every command, hint, and generated script renders the same name.
let invokedCommandName: CommandName | null = null;

// Resolve the invoked binary name from argv[1]'s basename. npm installs both
// `workeros` and `floom` bins pointing at the same script, so the basename of
// the executed path tells us which alias the user ran. Anything else (e.g. the
// raw `cli.js` path used in tests) falls back to the legacy `floom` name.
export function resolveCommandName(argv: string[] = process.argv): CommandName {
  const invoked = argv[1] ? basename(argv[1]) : "";
  return invoked === "workeros" ? "workeros" : "floom";
}

// Record the invoked name so downstream command/message code renders it.
export function setCommandName(name: CommandName): void {
  invokedCommandName = name;
}

// The invoked binary name for user-facing hints, scripts, and headers. Falls
// back to resolving from argv when main() has not run (e.g. unit tests calling
// a command function directly).
export function getCommandName(): CommandName {
  return invokedCommandName ?? resolveCommandName();
}
