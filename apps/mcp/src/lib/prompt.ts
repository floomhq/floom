import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";

// Streams are injectable so the prompt routing can be unit-tested without a pty.
// `data` is the machine-readable channel (stdout) that gates whether we prompt at
// all; `prompt` is where the question renders (stderr) so stdout stays clean.
export interface PromptStreams {
  input: NodeJS.ReadStream & { isTTY?: boolean };
  data: NodeJS.WriteStream & { isTTY?: boolean };
  prompt: NodeJS.WriteStream;
}

export async function promptYesNo(
  question: string,
  defaultYes = true,
  streams: Partial<PromptStreams> = {},
): Promise<boolean> {
  const input = streams.input ?? stdin;
  const data = streams.data ?? stdout;
  const prompt = streams.prompt ?? stderr;
  if (!input.isTTY || !data.isTTY) {
    return defaultYes;
  }
  // Render the prompt on stderr so stdout stays machine-readable (e.g. `--json`).
  const rl = createInterface({ input, output: prompt });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    if (!answer) return defaultYes;
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

export async function promptHidden(question: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("Cannot prompt for a secret in a non-interactive terminal");
  }
  return new Promise<string>((resolve, reject) => {
    let value = "";
    stdout.write(question);
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const onData = (chunk: string) => {
      const char = chunk;
      if (char === "\u0003") {
        cleanup();
        reject(new Error("Cancelled"));
        return;
      }
      if (char === "\r" || char === "\n") {
        stdout.write("\n");
        cleanup();
        resolve(value.trim());
        return;
      }
      if (char === "\u007f") {
        value = value.slice(0, -1);
        return;
      }
      value += char;
    };

    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
    };

    stdin.on("data", onData);
  });
}
