"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type ExecMode = "agent" | "pure-script" | "hybrid";

interface ExecModePickerProps {
  value: ExecMode;
  onChange: (mode: ExecMode) => void;
}

const EXEC_MODES: [ExecMode, string, string][] = [
  ["agent", "Agent (SKILL.md only)", "The agent reads SKILL.md and uses tools. No Python required."],
  ["pure-script", "Pure Python (run.py only)", "The Python script runs directly. No SKILL.md needed."],
  ["hybrid", "Hybrid (run.py + SKILL.md)", "Python controls flow and can invoke an agent helper via SKILL.md."],
];

export function ExecModePicker({ value, onChange }: ExecModePickerProps) {
  return (
    <Card className="border-[#eaeaea] shadow-none bg-white">
      <CardHeader>
        <CardTitle className="text-sm font-medium">Worker mode</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {EXEC_MODES.map(([mode, label, hint]) => (
          <label
            key={mode}
            className={`flex items-start gap-3 rounded-md border px-3 py-2.5 cursor-pointer transition-colors ${
              value === mode
                ? "border-black bg-[#f9f9f9]"
                : "border-[#e4e4e7] hover:border-[#ccc] hover:bg-[#fafafa]"
            }`}
          >
            <input
              type="radio"
              name="exec-mode"
              value={mode}
              checked={value === mode}
              onChange={() => onChange(mode)}
              className="mt-0.5 accent-black"
            />
            <div>
              <p className="text-sm font-medium text-[#222]">{label}</p>
              <p className="text-xs text-[#888] mt-0.5">{hint}</p>
            </div>
          </label>
        ))}
        {value === "hybrid" && (
          <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
            Hybrid runtime support (exposing SKILL.md to run.py at execution) is planned for a future release. Both files will be written to disk.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
