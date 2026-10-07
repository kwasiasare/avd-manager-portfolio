/**
 * Bounds how many `fn` calls run concurrently over `items`, via a small
 * pull-based worker pool — same design as sessionBatch.ts#runSessionBatch's
 * worker pool (AM-20), generalized here (AM-26 peer review item 11) for
 * per-host ARM fan-outs that aren't a session-batch operation and don't
 * need that function's SessionBatchResult/skip-vs-fail shape. Results are
 * returned in the SAME ORDER as `items`, not completion order — each
 * worker writes directly into its claimed index.
 *
 * Rejects (does not swallow) the first `fn` rejection, same as
 * `Promise.all` — callers that need per-item degradation instead of a
 * whole-batch failure must catch inside their own `fn`, same convention
 * imagesService.ts#getImageVersionsReport already follows per-host.
 */
export async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await fn(items[index], index);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}
