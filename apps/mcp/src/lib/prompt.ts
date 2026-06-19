import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export async function promptYesNo(question: string, defaultYes = true): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) {
    return defaultYes;
  }
  const rl = createInterface({ input: stdin, output: stdout });
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
