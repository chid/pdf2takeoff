/** "3-8,12" → [3, 4, 5, 6, 7, 8, 12], clipped to the document; empty = all. */
export function parsePages(spec: string | undefined, numPages: number): number[] {
  if (!spec || !spec.trim()) return Array.from({ length: numPages }, (_, i) => i + 1);
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const [a, b] = part.split('-').map((s) => parseInt(s.trim(), 10));
    for (let p = a; p <= (Number.isNaN(b) || b === undefined ? a : b); p++) if (p >= 1 && p <= numPages) out.add(p);
  }
  return [...out].sort((x, y) => x - y);
}
