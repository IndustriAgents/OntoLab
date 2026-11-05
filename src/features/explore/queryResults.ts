/** Preserve RDF values and prevent spreadsheet formulas when exporting results. */
export function queryResultsCsv(columns: string[], rows: Record<string, string>[]): string {
  const cell = (text: string) => {
    const safe = /^[\s]*[=+@-]/.test(text) || /^[\t\r]/.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  return (
    "\uFEFF" +
    [columns, ...rows.map((row) => columns.map((column) => row[column] ?? ""))].map((row) => row.map(cell).join(",")).join("\r\n")
  );
}
