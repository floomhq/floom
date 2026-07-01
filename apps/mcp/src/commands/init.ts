import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getCommandName } from "../lib/command-name.js";
import { getWorkerTemplate } from "../lib/worker-authoring.js";
import { log, printJson, printJsonError } from "../lib/output.js";

export type InitOptions = {
  template?: string;
  json?: boolean;
};

async function writeNewFile(path: string, content: string): Promise<void> {
  if (existsSync(path)) {
    throw new Error(`Refusing to overwrite existing file: ${path}`);
  }
  await writeFile(path, content, "utf8");
}

export async function initCommand(dirArg = ".", options: InitOptions = {}): Promise<number> {
  const templateId = options.template || "python-script";
  const template = getWorkerTemplate(templateId);
  if (!template) {
    const hint = `List templates: ${getCommandName()} workers templates list`;
    if (options.json) {
      printJsonError(`Unknown worker template '${templateId}'.`, hint);
    } else {
      log.err(`Unknown worker template '${templateId}'.`);
      log.info(hint);
    }
    return 1;
  }

  const dir = resolve(dirArg);
  const files = [
    { path: join(dir, "worker.yml"), content: template.worker_yml },
    ...(template.run_py ? [{ path: join(dir, "run.py"), content: template.run_py }] : []),
    ...(template.skill_md ? [{ path: join(dir, "SKILL.md"), content: template.skill_md }] : []),
  ];

  try {
    await mkdir(dir, { recursive: true });
    for (const file of files) {
      await writeNewFile(file.path, file.content);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      printJsonError(message);
    } else {
      log.err(message);
    }
    return 1;
  }

  const payload = {
    directory: dir,
    template: template.id,
    files: files.map((file) => file.path),
  };
  if (options.json) {
    printJson(payload);
  } else {
    log.ok(`Initialized worker in ${dir}`);
    log.kv("Template", template.id);
    log.info(`Next: ${getCommandName()} workers validate ${dir}`);
  }
  return 0;
}
