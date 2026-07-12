// LogTape's active severities plus "silent" (mapped to a noop sink by the
// configurator). Shared so every app/package speaks the same level vocabulary.
export type LogLevel =
  | "debug"
  | "info"
  | "warning"
  | "error"
  | "fatal"
  | "silent";
