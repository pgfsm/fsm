// Canonical LogTape category namespaces. Libraries call getLogger([CATEGORY.db,
// ...]) with their own namespace; the app entry point decides which of these
// its process should surface (and at what level) via configureLogging().
export const CATEGORY = {
  api: "@pgfsm/api",
  worker: "@pgfsm/worker",
  db: "@pgfsm/db",
  compiler: "@pgfsm/compiler",
  fsmlet: "@pgfsm/fsmlet",
  scheduler: "@pgfsm/scheduler",
} as const;

export type Category = typeof CATEGORY[keyof typeof CATEGORY];
