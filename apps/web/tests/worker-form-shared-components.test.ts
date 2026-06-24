/**
 * PR S7 — shared worker-form component smoke test.
 *
 * Verifies that TriggersEditor and FilesEditor are exported from the shared
 * worker-form barrel and that both /workers/new and /workers/[id]/edit can
 * resolve the same component references.
 *
 * This is a build-time type check (no test runner required). Run:
 *   cd apps/web && npm run build   -- verifies TypeScript resolves all imports.
 */

// Verify the shared types are exported from the barrel
import type { TriggerRow, TriggerType } from "@/components/worker-form";

import {
  FilesEditor,
  TriggersEditor,
  buildTriggersYaml,
  defaultTriggerRow,
  makeTriggerRow,
  replaceTriggerBlock,
} from "@/components/worker-form";

// Verify type consistency
const _row: TriggerRow = defaultTriggerRow();
const _triggerType: TriggerType = "manual";

// Verify YAML helpers are callable
const _yaml = buildTriggersYaml([_row]);
const _row2 = makeTriggerRow({ type: "manual" });
const _replaced = replaceTriggerBlock("trigger:\n  type: manual", _yaml);

// Verify components are exported (React components are functions/classes)
const _components = [FilesEditor, TriggersEditor];

// Suppress unused variable lint warnings
void _triggerType;
void _yaml;
void _row2;
void _replaced;
void _components;
