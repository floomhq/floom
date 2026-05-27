type TableColumn<T> = {
  key: keyof T;
  label: string;
};

const COLOR = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
};

function supportsColor(): boolean {
  return Boolean(process.stdout.isTTY);
}

function paint(text: string, color: keyof typeof COLOR): string {
  if (!supportsColor()) return text;
  return `${COLOR[color]}${text}${COLOR.reset}`;
}

export function ok(text: string): string {
  return paint(text, "green");
}

export function warn(text: string): string {
  return paint(text, "yellow");
}

export function errorText(text: string): string {
  return paint(text, "red");
}

export function dim(text: string): string {
  return paint(text, "dim");
}

export function renderTable<T extends Record<string, unknown>>(rows: T[], columns: TableColumn<T>[]): string {
  if (!rows.length) return "(no rows)";
  const widths = columns.map((column) => {
    const maxCell = rows.reduce((max, row) => {
      const value = row[column.key];
      const text = value === undefined || value === null ? "" : String(value);
      return Math.max(max, text.length);
    }, column.label.length);
    return maxCell;
  });
  const header = columns
    .map((column, idx) => column.label.padEnd(widths[idx], " "))
    .join("  ");
  const separator = columns.map((_, idx) => "-".repeat(widths[idx])).join("  ");
  const body = rows.map((row) =>
    columns
      .map((column, idx) => {
        const value = row[column.key];
        const text = value === undefined || value === null ? "" : String(value);
        return text.padEnd(widths[idx], " ");
      })
      .join("  "));
  return [header, separator, ...body].join("\n");
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
