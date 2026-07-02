import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkerFlow } from "@/components/WorkerFlow";

describe("WorkerFlow connection chips", () => {
  it("renders known connection tools as brand logos instead of visible text", () => {
    const { container } = render(
      <WorkerFlow
        workerName="ElevenLabs MFA Daily Check-in"
        inputs={[{ label: "Schedule", type: "trigger" }]}
        outputs={[{ label: "Result", type: "text" }]}
        connections={["gmail"]}
        triggerType="cron"
      />,
    );

    const chip = screen.getByLabelText("Gmail");
    const brandUse = chip.querySelector("use");

    expect(brandUse?.getAttribute("href")).toBe("#brand-gmail");
    expect(screen.queryByText("gmail")).not.toBeInTheDocument();
    expect(container.textContent).toContain("ElevenLabs MFA Daily Check-in");
  });

  it("keeps text for connection tools without a registered brand logo", () => {
    render(
      <WorkerFlow
        workerName="Custom Tool Worker"
        connections={["internal_crm"]}
      />,
    );

    expect(screen.getByText("Internal Crm")).toBeInTheDocument();
  });

  it("renders Linear as a highlighted text chip", () => {
    const { container } = render(
      <WorkerFlow
        workerName="Linear Follow-up"
        connections={["linear"]}
      />,
    );

    const chip = screen.getByText("Linear").closest("span");
    expect(chip).toBeTruthy();
    expect(chip?.getAttribute("style")).toContain("color-mix");
    expect(container.querySelector('use[href="#brand-linear"]')).toBeTruthy();
  });
});
