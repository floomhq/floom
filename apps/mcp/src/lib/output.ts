import chalk from "chalk";

export const log = {
  info: (msg: string): void => { process.stdout.write(`${msg}\n`); },
  ok: (msg: string): void => { process.stdout.write(`${chalk.green("✓ ")}${msg}\n`); },
  warn: (msg: string): void => { process.stderr.write(`${chalk.yellow("! ")}${msg}\n`); },
  err: (msg: string): void => { process.stderr.write(`${chalk.red("✗ ")}${msg}\n`); },
  step: (msg: string): void => { process.stdout.write(`${chalk.dim("· ")}${msg}\n`); },
  heading: (msg: string): void => { process.stdout.write(`\n${chalk.bold(msg)}\n`); },
  kv: (key: string, value: string): void => { process.stdout.write(`  ${chalk.dim(key.padEnd(18))}${value}\n`); },
  blank: (): void => { process.stdout.write("\n"); },
};

export function exitWith(code: number, msg?: string): never {
  if (msg) log.err(msg);
  process.exit(code);
}

type TableColumn<T> = {
  key: keyof T;
  label: string;
};

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
