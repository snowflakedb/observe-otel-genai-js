// Remembers which functions `wrapQuery` returned, so a module is never wrapped twice.
const tracedQueries = new WeakSet<object>();

export function markTraced(fn: object): void {
  tracedQueries.add(fn);
}

export function isTracedQuery(fn: unknown): boolean {
  return typeof fn === 'function' && tracedQueries.has(fn);
}
