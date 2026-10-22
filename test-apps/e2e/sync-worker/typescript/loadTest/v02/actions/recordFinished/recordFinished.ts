// Action: recordFinished — runs on the transition to Finished, once all four
// languages' loadWork actors have reported back. Stamps the context, so the
// acceptance suite (#458) can tell the sync action ran too; the rest of the
// context (e.g. the suite's e2eRunId tag) is kept.
export function recordFinished(context: any, _event: any) {
  return { ...(context ?? {}), finishedAt: new Date().toISOString() };
}
