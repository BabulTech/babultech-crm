/**
 * Reading a pasted .env file, for the vault's "Environment file" kind.
 *
 * The file itself is stored exactly as pasted, comments and blank lines
 * included, so "Copy all" gives back what went in. This only works out which
 * lines are variables, for the count, the searchable names and the table on
 * reveal. Safe for client components.
 */

export interface EnvVariable { key: string; value: string; line: number }

const KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export function parseEnvFile(text: string): { variables: EnvVariable[]; invalidLines: number[] } {
  const variables: EnvVariable[] = [];
  const invalidLines: number[] = [];
  text.replace(/\r\n?/g, "\n").split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = body.indexOf("=");
    const key = eq > 0 ? body.slice(0, eq).trim() : "";
    if (!KEY.test(key)) { invalidLines.push(i + 1); return; }
    let value = body.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) value = value.slice(1, -1);
    variables.push({ key, value, line: i + 1 });
  });
  return { variables, invalidLines };
}

/** The variable names, de-duplicated, in file order. */
export function envKeys(text: string): string[] {
  return [...new Set(parseEnvFile(text).variables.map((v) => v.key))];
}
