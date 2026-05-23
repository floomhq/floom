from typing import Any, Dict


def run(inputs: Dict[str, Any], context) -> Dict[str, Any]:
    log = context.log if hasattr(context, "log") else context["log"]
    log("Run started")
    summary = (
        f"# Input Types Test\n\n"
        f"- text: `{inputs.get('text_input')}`\n"
        f"- textarea: `{inputs.get('textarea_input') or '(empty)'}`\n"
        f"- number: `{inputs.get('number_input')}`\n"
        f"- select: `{inputs.get('select_input')}`\n"
        f"- boolean: `{inputs.get('boolean_input')}`\n"
        f"- file (truncated): `{(inputs.get('file_input') or '')[:80]}...`\n"
    )
    log("Summary built")
    return {
        "status": "success",
        "outputs": {"summary": summary, "raw_inputs": inputs},
        "artifacts": [],
    }
