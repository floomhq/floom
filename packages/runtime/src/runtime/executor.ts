/**
 * The executor: runs a manifest's `run` command in a sandbox, streaming
 * stdout/stderr back to the caller.
 *
 * Grounding:
 *   - H2 Test 5 and Suite F: `onStdout` callback is sub-3ms jitter,
 *     safe for streaming to the web renderer (or any caller). No buffering
 *     or polling needed.
 *   - Suite F: the default SDK `commands.run` timeout is 60s. For longer
 *     runs the caller must pass `timeoutMs` on RunOptions.
 */
import type { Sandbox } from '@e2b/code-interpreter';
import { CommandExitError } from '@e2b/code-interpreter';
import type { Manifest } from './types.ts';

function parseTimeout(value: string | undefined): number {
  if (!value) return 60_000;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  const m = trimmed.match(/^(\d+)(ms|s|m|h)$/);
  if (!m) return 60_000;
  const n = parseInt(m[1]!, 10);
  const unit = m[2]!;
  switch (unit) {
    case 'ms': return n;
    case 's': return n * 1000;
    case 'm': return n * 60_000;
    case 'h': return n * 3_600_000;
    default: return 60_000;
  }
}

/**
 * Compose the shell command to execute inside the sandbox.
 *
 * For argv inputs we append `--<name> <value>` (quoted with single quotes
 * and inner single quotes escaped). For env inputs the value is returned
 * separately as an env record and the caller forwards it to `commands.run`.
 * Stdin inputs are joined with newlines and returned as the stdin string.
 */
export function buildRunCommand(
  manifest: Manifest,
  inputs: Record<string, unknown>,
): { cmd: string; envs: Record<string, string>; stdin?: string } {
  const cwd = manifest.workdir ? `cd ${manifest.workdir} && ` : '';
  const argvParts: string[] = [];
  const envs: Record<string, string> = {};
  const stdinParts: string[] = [];

  for (const input of manifest.inputs) {
    const rawValue = inputs[input.name];
    const value = rawValue === undefined ? input.default : rawValue;
    if (value === undefined || value === null) {
      if (input.required) {
        throw new Error(`Missing required input: ${input.name}`);
      }
      continue;
    }
    const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
    switch (input.from ?? 'argv') {
      case 'argv': {
        // Single-quote and escape embedded single quotes via the
        // POSIX-standard `'\''` trick.
        const escaped = stringValue.replace(/'/g, `'\\''`);
        argvParts.push(`--${input.name} '${escaped}'`);
        break;
      }
      case 'env': {
        envs[input.name.toUpperCase()] = stringValue;
        break;
      }
      case 'stdin': {
        stdinParts.push(stringValue);
        break;
      }
    }
  }

  const argv = argvParts.length ? ' ' + argvParts.join(' ') : '';
  const cmd = `${cwd}${manifest.run}${argv}`;
  const stdin = stdinParts.length ? stdinParts.join('\n') : undefined;
  return { cmd, envs, stdin };
}

export interface ExecuteOptions {
  onStream?: (chunk: string) => void;
  timeoutMs?: number;
  secrets?: Record<string, string>;
}

export interface ExecuteResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  runMs: number;
}

/**
 * Execute a manifest's run command inside the given sandbox. Returns stdout,
 * stderr, exit code, and the wall time. Streams stdout via onStream as it
 * arrives.
 */
export async function execute(
  sandbox: Sandbox,
  manifest: Manifest,
  inputs: Record<string, unknown>,
  opts: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const { cmd, envs: inputEnvs, stdin } = buildRunCommand(manifest, inputs);

  // Stdin-feeding is done via shell heredoc since the SDK's `run` does not
  // expose a one-shot stdin payload for foreground commands. This keeps the
  // executor dependency-light.
  const finalCmd = stdin !== undefined
    ? `cat <<'FLOOM_STDIN_EOF' | ${cmd}\n${stdin}\nFLOOM_STDIN_EOF`
    : cmd;

  const envs: Record<string, string> = {
    ...(opts.secrets ?? {}),
    ...inputEnvs,
  };

  const timeoutMs = opts.timeoutMs ?? parseTimeout(manifest.timeout);
  const t0 = Date.now();
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  // The SDK's Commands.run throws `CommandExitError` on non-zero exit (the
  // class implements `CommandResult` so exitCode/stdout/stderr are accessible
  // on the error). We treat non-zero as a normal return value for Floom apps
  // because the web renderer needs to show "your app exited with 1" messages,
  // not crash. Timeouts still throw `TimeoutError` and bubble up.
  let exitCode: number;
  let rawStdout: string;
  let rawStderr: string;
  try {
    const result = await sandbox.commands.run(finalCmd, {
      envs,
      timeoutMs,
      onStdout: (data: string) => {
        stdoutChunks.push(data);
        if (opts.onStream) opts.onStream(data);
      },
      onStderr: (data: string) => {
        stderrChunks.push(data);
        // Stderr is intentionally NOT streamed to the caller — users don't
        // want to see pip's deprecation warnings alongside their output. The
        // Floom backend can decide to surface stderr only on non-zero exit.
      },
    });
    exitCode = result.exitCode;
    rawStdout = result.stdout ?? '';
    rawStderr = result.stderr ?? '';
  } catch (err) {
    if (err instanceof CommandExitError) {
      exitCode = err.exitCode;
      rawStdout = err.stdout ?? '';
      rawStderr = err.stderr ?? '';
    } else {
      throw err;
    }
  }

  const runMs = Date.now() - t0;

  return {
    exitCode,
    stdout: stdoutChunks.length ? stdoutChunks.join('') : rawStdout,
    stderr: stderrChunks.length ? stderrChunks.join('') : rawStderr,
    runMs,
  };
}

/**
 * Run a shell command directly in the sandbox without manifest semantics.
 * Used by the deploy pipeline (clone, build, smoke test). Not part of the
 * public runApp API.
 */
export async function runShell(
  sandbox: Sandbox,
  cmd: string,
  opts: {
    timeoutMs?: number;
    envs?: Record<string, string>;
    onStream?: (chunk: string) => void;
  } = {},
): Promise<ExecuteResult> {
  const t0 = Date.now();
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  let exitCode: number;
  let rawStdout: string;
  let rawStderr: string;
  try {
    const result = await sandbox.commands.run(cmd, {
      envs: opts.envs ?? {},
      timeoutMs: opts.timeoutMs ?? 300_000,
      onStdout: (data: string) => {
        stdoutChunks.push(data);
        if (opts.onStream) opts.onStream(data);
      },
      onStderr: (data: string) => {
        stderrChunks.push(data);
        if (opts.onStream) opts.onStream(data);
      },
    });
    exitCode = result.exitCode;
    rawStdout = result.stdout ?? '';
    rawStderr = result.stderr ?? '';
  } catch (err) {
    if (err instanceof CommandExitError) {
      exitCode = err.exitCode;
      rawStdout = err.stdout ?? '';
      rawStderr = err.stderr ?? '';
    } else {
      throw err;
    }
  }

  return {
    exitCode,
    stdout: stdoutChunks.length ? stdoutChunks.join('') : rawStdout,
    stderr: stderrChunks.length ? stderrChunks.join('') : rawStderr,
    runMs: Date.now() - t0,
  };
}

/** Exported for tests. */
export const __test = { parseTimeout };
