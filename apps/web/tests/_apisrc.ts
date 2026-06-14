/**
 * Shared backend-source helper for the grep-based contract tests.
 *
 * Many fl-batch-*.test.ts assertions check that the backend *defines* some
 * endpoint or helper by grepping a single file (historically apps/api/main.py).
 * The #1073 refactor split main.py into routers/*.py + services/*.py, which
 * silently broke every such test even though the features were intact.
 *
 * apiAll() greps the WHOLE apps/api tree (excluding tests/ + caches), so these
 * "the backend implements X" existence checks survive file moves. Use it for
 * positive existence assertions; keep single-file reads only where a test
 * deliberately asserts something about one specific file.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { resolve } from "path";

const API_ROOT = resolve(__dirname, "../../api");
let _cache: string | null = null;

export function apiAll(): string {
  if (_cache !== null) return _cache;
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = resolve(dir, entry);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (entry !== "tests" && entry !== "__pycache__" && entry !== "node_modules") {
          walk(p);
        }
      } else if (entry.endsWith(".py")) {
        out.push(readFileSync(p, "utf8"));
      }
    }
  };
  walk(API_ROOT);
  _cache = out.join("\n");
  return _cache;
}
