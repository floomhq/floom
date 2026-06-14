/**
 * Edit-source editor white-space fix.
 *
 * react-simple-code-editor styles its inner <pre>/<textarea> inline as
 * white-space:pre-wrap + word-break:keep-all. Inside the narrow Edit-source
 * dialog column that collapsed code to one character per line. The fix wires a
 * scoped `.fe-codeeditor` class (+ preClassName/textareaClassName) whose global
 * !important rules force white-space:pre and horizontal scroll. These tests pin
 * the wiring so the regression can't silently come back.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FilesEditor } from "@/components/worker-form";

const pyContent = "def run(inputs):\n    return {'ok': True, 'msg': 'a very long line that must not wrap to one char per line'}\n";

function renderEdit(onChange = vi.fn()) {
  return render(
    <FilesEditor
      mode="edit"
      files={[
        { path: "worker.yml", content: "name: demo\n" },
        { path: "run.py", content: pyContent },
      ]}
      selectedPath="run.py"
      onChange={onChange}
    />,
  );
}

// run.py defaults to the rendered "Preview" tab; the editable editor lives in
// the "Raw" mode. Switch to it first.
async function gotoRaw() {
  const user = userEvent.setup();
  const rawBtn = screen.queryByRole("button", { name: /^Raw$/i });
  if (rawBtn) await user.click(rawBtn);
  return user;
}

describe("FilesEditor edit mode — code renders normally (not one char per line)", () => {
  it("renders the editable code editor with the white-space-fix class on a .py file", async () => {
    renderEdit();
    await gotoRaw();
    // The textarea (editable layer of react-simple-code-editor) must carry the
    // white-space-fix class so the global rule forces white-space:pre.
    const textarea = document.querySelector("textarea.fe-codeeditor-textarea") as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();
    expect(textarea!.value).toContain("def run(inputs):");

    // The container the library renders also carries the scroll/white-space class.
    expect(document.querySelector(".fe-codeeditor")).not.toBeNull();
    // The highlight <pre> layer carries its fix class too.
    expect(document.querySelector("pre.fe-codeeditor-pre")).not.toBeNull();
  });

  it("emits edited content through onChange", async () => {
    const onChange = vi.fn();
    renderEdit(onChange);
    await gotoRaw();
    const textarea = document.querySelector("textarea.fe-codeeditor-textarea") as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(textarea, pyContent + "# edited\n");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onChange).toHaveBeenCalled();
  });
});
