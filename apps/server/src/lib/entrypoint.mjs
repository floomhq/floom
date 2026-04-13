/**
 * Floom app entrypoint (Node.js).
 *
 * Called by the floom-docker runner. Imports the user's app module, calls the
 * requested action function with inputs as a single object arg, and prints a
 * single JSON line to stdout describing the result.
 *
 * Protocol:
 *   stdin  : nothing
 *   argv[2]: JSON string {"action": "...", "inputs": {...}}
 *   stdout : single line prefixed with __FLOOM_RESULT__ followed by JSON:
 *              {"ok": true,  "outputs": ...}
 *            or
 *              {"ok": false, "error": "...", "error_type": "...", "logs": "..."}
 *
 * The user's module must export named functions matching action names, or a
 * default export object with those functions. Module candidates (tried in
 * order): app.ts, app.mjs, app.js, index.ts, index.mjs, index.js.
 */
import { resolve } from 'node:path';

function emit(payload) {
  // Keep on a single line so the server can parse it.
  process.stdout.write('__FLOOM_RESULT__' + JSON.stringify(payload) + '\n');
}

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    emit({ ok: false, error: 'Missing config argument', error_type: 'runtime_error' });
    process.exit(1);
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (e) {
    emit({ ok: false, error: `Invalid config JSON: ${e.message}`, error_type: 'runtime_error' });
    process.exit(1);
  }

  const action = config.action || 'run';
  const inputs = config.inputs || {};

  // Import the user's module.
  console.log('Importing app module...');

  const candidates = ['app.ts', 'app.mjs', 'app.js', 'index.ts', 'index.mjs', 'index.js'];
  let mod = null;

  for (const name of candidates) {
    try {
      mod = await import(resolve('/app', name));
      break;
    } catch (e) {
      // ERR_MODULE_NOT_FOUND / MODULE_NOT_FOUND means the file doesn't exist;
      // try the next candidate. Any other error is a real problem.
      if (e.code !== 'ERR_MODULE_NOT_FOUND' && e.code !== 'MODULE_NOT_FOUND') {
        const errorType = e instanceof SyntaxError ? 'syntax_error' : 'runtime_error';
        emit({
          ok: false,
          error: `Error importing ${name}: ${e.message}`,
          error_type: errorType,
          logs: e.stack || '',
        });
        process.exit(1);
      }
    }
  }

  if (!mod) {
    emit({
      ok: false,
      error: `No app module found. Expected one of: ${candidates.join(', ')}`,
      error_type: 'runtime_error',
    });
    process.exit(1);
  }

  // Resolve the action function: named export, or property on default export.
  const fn = typeof mod[action] === 'function'
    ? mod[action]
    : (mod.default && typeof mod.default[action] === 'function')
      ? mod.default[action]
      : null;

  if (!fn) {
    const available = Object.keys(mod)
      .filter(k => typeof mod[k] === 'function' && !k.startsWith('_'))
      .concat(
        mod.default && typeof mod.default === 'object'
          ? Object.keys(mod.default).filter(k => typeof mod.default[k] === 'function' && !k.startsWith('_'))
          : []
      );
    emit({
      ok: false,
      error: `Action '${action}' not found. Available: ${available.join(', ') || '(none)'}`,
      error_type: 'invalid_action',
    });
    process.exit(1);
  }

  // Run the action.
  console.log(`Running action '${action}'...`);
  try {
    let result = await fn(inputs);

    // Wrap non-object results so the server always gets a dict shape back.
    if (result === null || result === undefined || typeof result !== 'object' || Array.isArray(result)) {
      result = { result };
    }

    emit({ ok: true, outputs: result });
  } catch (e) {
    // Detect missing secrets: KeyError-equivalent for process.env access.
    const stack = e.stack || '';
    if (
      e instanceof TypeError &&
      (stack.includes('process.env') || stack.includes('environ'))
    ) {
      emit({
        ok: false,
        error: `Missing secret: ${e.message}`,
        error_type: 'missing_secret',
        logs: stack,
      });
      process.exit(1);
    }

    const errorType = e instanceof SyntaxError ? 'syntax_error' : 'runtime_error';
    emit({
      ok: false,
      error: e.message || String(e),
      error_type: errorType,
      logs: stack,
    });
    process.exit(1);
  }
}

main();
