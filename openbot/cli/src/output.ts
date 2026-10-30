/** How the CLI prints: a table for people, the server's JSON as it came for `--json` and scripts. */
import { formatCredits } from "@openbot/shared/wallet";

export type Printer = {
  json: boolean;
  out: (line: string) => void;
};

export function table(
  printer: Printer,
  rows: Record<string, unknown>[],
  columns: string[],
  raw: unknown = rows,
) {
  if (printer.json) return printer.out(JSON.stringify(raw, null, 2));
  if (rows.length === 0) return printer.out("(none)");
  const cell = (value: unknown) =>
    value === null || value === undefined
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  const widths = columns.map((column) =>
    Math.min(
      60,
      Math.max(column.length, ...rows.map((row) => cell(row[column]).length)),
    ),
  );
  const line = (values: string[]) =>
    values
      .map((value, index) =>
        value.slice(0, widths[index]).padEnd(widths[index] ?? 0),
      )
      .join("  ")
      .trimEnd();
  printer.out(line(columns.map((column) => column.toUpperCase())));
  for (const row of rows)
    printer.out(line(columns.map((column) => cell(row[column]))));
}

export function show(printer: Printer, value: unknown, lines: string[]) {
  if (printer.json) printer.out(JSON.stringify(value, null, 2));
  else for (const line of lines) printer.out(line);
}

export const credits = formatCredits;
