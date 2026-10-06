import type { ApiTarget } from "./api-target.ts";
import { CtlError, ExitCode } from "./exit.ts";

/**
 * Calls the pgfsm REST API with the target's key and returns the parsed JSON
 * body. Non-2xx responses become a CtlError with the matching exit code
 * (SPEC-009 §6): 401/403 → 3, 404 → 4, anything else → 1, carrying the
 * server's message and any `problems` it listed.
 */
export async function apiRequest<T>(
  target: ApiTarget,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${target.url}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${target.apiKey}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new CtlError(
      ExitCode.GENERAL,
      `Can't reach the pgfsm API at ${url}: ${(err as Error).message}`,
      undefined,
      { cause: err },
    );
  }

  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (res.ok) return json as T;

  const { message, problems } = (json ?? {}) as {
    message?: string;
    problems?: string[];
  };
  const detail = [
    `${method} ${path} → ${res.status}${message ? `: ${message}` : ""}`,
    ...(problems ?? []).map((p) => `  - ${p}`),
  ].join("\n");

  if (res.status === 401 || res.status === 403) {
    throw new CtlError(ExitCode.AUTH, detail);
  }
  if (res.status === 404) {
    throw new CtlError(
      ExitCode.NOT_FOUND,
      path.startsWith("/admin/")
        ? `${detail}\n(/admin/* exists only when the API runs with --enable-admin-api; check the URL includes the API's path prefix, e.g. …/fsm)`
        : detail,
    );
  }
  throw new CtlError(ExitCode.GENERAL, detail);
}
