/**
 * Patches or inserts a `default:` field for a named input inside a worker.yml string.
 *
 * Finds the input block by `- name: "<inputName>"` and either replaces an
 * existing `default:` line or inserts one after the last field in the block.
 * Returns the original YAML unchanged if the input name is not found.
 */
export function patchInputDefault(yaml: string, inputName: string, value: string): string {
  const lines = yaml.split("\n");
  let inTargetBlock = false;
  let fieldIndent = "      ";
  let defaultLineIdx = -1;
  let lastFieldIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    if (trimmed.startsWith("- name:")) {
      if (inTargetBlock) break; // next input block starts — we're done
      const nameVal = trimmed.slice("- name:".length).trim().replace(/^["']|["']$/g, "");
      if (nameVal === inputName) {
        inTargetBlock = true;
        fieldIndent = " ".repeat(indent + 2);
        lastFieldIdx = i;
      }
    } else if (inTargetBlock) {
      // A non-empty line with less indentation than a field means the block ended
      if (trimmed !== "" && indent < fieldIndent.length) break;
      if (trimmed.startsWith("default:")) {
        defaultLineIdx = i;
      }
      if (trimmed && !trimmed.startsWith("#")) {
        lastFieldIdx = i;
      }
    }
  }

  if (!inTargetBlock) return yaml;

  if (defaultLineIdx >= 0) {
    lines[defaultLineIdx] = `${fieldIndent}default: ${JSON.stringify(value)}`;
  } else {
    lines.splice(lastFieldIdx + 1, 0, `${fieldIndent}default: ${JSON.stringify(value)}`);
  }
  return lines.join("\n");
}
