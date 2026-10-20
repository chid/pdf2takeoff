// The v0.1 benchmark used sort(() => rng() - 0.5). Its random comparator
// consumed a different number of random values after a runtime sort change.
// Freeze the historical short-array run detection and binary insertion order
// so the published seed produces the original sheets and question IDs.
// This preserves v0.1 data; it is not a general-purpose uniform shuffle.
export function shuffleV01(items, rng) {
  const a = [...items];
  if (a.length < 2) return a;
  let run = 2;
  const descending = rng() < 0.5;
  while (run < a.length) {
    const less = rng() < 0.5;
    if (descending ? !less : less) break;
    run++;
  }
  if (descending) {
    const reversed = a.slice(0, run).reverse();
    for (let i = 0; i < run; i++) a[i] = reversed[i];
  }
  for (let i = run; i < a.length; i++) {
    const pivot = a[i];
    let left = 0, right = i;
    while (left < right) {
      const mid = (left + right) >>> 1;
      if (rng() < 0.5) right = mid;
      else left = mid + 1;
    }
    for (let j = i; j > left; j--) a[j] = a[j - 1];
    a[left] = pivot;
  }
  return a;
}
