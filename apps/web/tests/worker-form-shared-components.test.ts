/**
 * PR S7 — shared worker-form component smoke test.
 *
 * Verifies that TriggersEditor and RequirementsEditor are exported from the
 * shared worker-form barrel and that both /workers/new and /workers/[id]/edit
 * can resolve the same component references.
 *
 * This is a build-time type check (no test runner required). Run:
 *   cd apps/web && npm run build   -- verifies TypeScript resolves all imports.
 */

// Verify all 5 shared components are exported from the barrel
import type {
  DetectedEntry,
  ExecMode,
  TriggerRow,
  TriggerType,
  WorkerMetadataValues,
} from "@/components/worker-form";

import {
  ExecModePicker,
  FilesEditor,
  RequirementsEditor,
  TriggersEditor,
  WorkerMetadataForm,
  buildTriggersYaml,
  defaultTriggerRow,
  makeTriggerRow,
  replaceTriggerBlock,
} from "@/components/worker-form";

// Verify type consistency
const _mode: ExecMode = "agent";
const _entry: DetectedEntry = "SKILL.md";
const _row: TriggerRow = defaultTriggerRow();
const _triggerType: TriggerType = "manual";
const _meta: WorkerMetadataValues = { workerId: "test", name: "Test" };

// Verify YAML helpers are callable
const _yaml = buildTriggersYaml([_row]);
const _row2 = makeTriggerRow({ type: "manual" });
const _replaced = replaceTriggerBlock("trigger:\n  type: manual", _yaml);

// Verify components are exported (React components are functions/classes)
const _components = [ExecModePicker, FilesEditor, RequirementsEditor, TriggersEditor, WorkerMetadataForm];

// Suppress unused variable lint warnings
void _mode;
void _entry;
void _triggerType;
void _meta;
void _yaml;
void _row2;
void _replaced;
void _components;
