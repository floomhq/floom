import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { CronBuilder } from "@/components/CronBuilder";

describe("CronBuilder empty schedule", () => {
  it("does not invent a cron until the operator selects a preset", () => {
    const onChange = vi.fn();
    render(<CronBuilder value="" timezone="Europe/Berlin" onChange={onChange} />);

    expect(screen.getByPlaceholderText("0 9 * * *")).toHaveValue("");
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Every minute" }));
    expect(onChange).toHaveBeenLastCalledWith("* * * * *");
  });
});
