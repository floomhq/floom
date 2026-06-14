import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  TriggersEditor,
  makeTriggerRow,
  buildTriggersYaml,
  replaceTriggerBlock,
  type TriggerRow,
} from "@/components/worker-form";

// W-02: a worker's trigger must be editable in the UI. The Config → Triggers
// tab wires the shared TriggersEditor; these tests prove the edit surface and
// the worker.yml persistence math the tab depends on.

vi.mock("@/components/CronBuilder", () => ({
  CronBuilder: ({ value }: { value: string }) => <div data-testid="cron-builder">{value}</div>,
}));
vi.mock("@/components/ConnectionEventPicker", () => ({
  ConnectionEventPicker: () => <div data-testid="connection-event-picker" />,
}));

function Harness({ initial }: { initial: TriggerRow[] }) {
  const [rows, setRows] = useState<TriggerRow[]>(initial);
  return <TriggersEditor rows={rows} onChange={setRows} dirty onSave={() => {}} onDiscard={() => {}} />;
}

describe("W-02 editable triggers", () => {
  it("renders the current schedule trigger as an editable summary row", () => {
    render(<Harness initial={[makeTriggerRow({ type: "cron", cron: "0 9 * * MON", timezone: "Europe/Berlin" })]} />);
    // Summary shows the configured kind + edit affordance.
    expect(screen.getByText("Schedule")).toBeInTheDocument();
    expect(screen.getByTitle("Edit trigger")).toBeInTheDocument();
    expect(screen.getByText("Add trigger")).toBeInTheDocument();
    expect(screen.getByText("Save triggers")).toBeInTheDocument();
  });

  it("expands into the full editor (type picker + cron builder) when Edit is clicked", () => {
    render(<Harness initial={[makeTriggerRow({ type: "cron", cron: "0 9 * * MON", timezone: "Europe/Berlin" })]} />);
    fireEvent.click(screen.getByTitle("Edit trigger"));
    // Expanded editor: the segmented type picker + cron builder + timezone field.
    expect(screen.getByText("Manual")).toBeInTheDocument();
    expect(screen.getByText("Webhook")).toBeInTheDocument();
    expect(screen.getByTestId("cron-builder")).toHaveTextContent("0 9 * * MON");
    expect(screen.getByPlaceholderText("Europe/Berlin")).toBeInTheDocument();
  });

  it("lets the user change the schedule to a webhook trigger", () => {
    render(<Harness initial={[makeTriggerRow({ type: "cron", cron: "0 9 * * MON" })]} />);
    fireEvent.click(screen.getByTitle("Edit trigger"));
    fireEvent.click(screen.getByText("Webhook"));
    // Webhook subtitle confirms the active type switched.
    expect(screen.getByText(/HTTP POST/i)).toBeInTheDocument();
  });

  it("buildTriggersYaml + replaceTriggerBlock rewrite an existing trigger block in worker.yml", () => {
    const yaml = [
      "name: daily-standup",
      "description: emails standups",
      "trigger:",
      "  type: schedule",
      '  cron: "0 9 * * MON"',
      '  timezone: "Europe/Berlin"',
      "exec:",
      "  runtime: skill",
    ].join("\n");

    const next = buildTriggersYaml([makeTriggerRow({ type: "manual" })]);
    const out = replaceTriggerBlock(yaml, next);

    expect(out).toContain("trigger:");
    expect(out).toContain("type: manual");
    // The old schedule fields are gone; surrounding keys are preserved.
    expect(out).not.toContain('cron: "0 9 * * MON"');
    expect(out).toContain("name: daily-standup");
    expect(out).toContain("exec:");
    expect(out).toContain("runtime: skill");
  });

  it("writes a schedule trigger block with cron + timezone", () => {
    const yaml = ["name: w", "trigger:", "  type: manual", "exec:", "  runtime: skill"].join("\n");
    const next = buildTriggersYaml([
      makeTriggerRow({ type: "cron", cron: "30 8 * * *", timezone: "UTC" }),
    ]);
    const out = replaceTriggerBlock(yaml, next);
    expect(out).toContain("type: schedule");
    expect(out).toContain('cron: "30 8 * * *"');
    expect(out).toContain('timezone: "UTC"');
    expect(out).toContain("runtime: skill");
  });
});
