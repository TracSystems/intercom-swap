export function banner(title) {
  const line = "═".repeat(Math.max(10, title.length + 6));
  return `\n${line}\n  ${title}\n${line}\n`;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function fmt(n, d = 6) {
  if (n === undefined || n === null) return "-";
  const x = typeof n === "string" ? Number(n) : n;
  if (Number.isNaN(x)) return String(n);
  return x.toFixed(d);
}
