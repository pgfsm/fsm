// The API's licence notice (SPEC-017). @pgfsm/api is AGPL-3.0-only, and
// AGPL-3.0 §13 obliges whoever runs a modified version to offer its source to
// the users who interact with it over a network. GET / and the OpenAPI
// document report the licence and where the source is; PGFSM_SOURCE_URL
// points that at a modified version's own source. Kept free of env.ts so route
// modules stay importable (and testable) without the API's environment.

/** The SPDX identifier of @pgfsm/api's licence. */
export const LICENSE_SPDX = "AGPL-3.0-only";

/** The licence text. */
export const LICENSE_URL = "https://www.gnu.org/licenses/agpl-3.0.html";

/** The unmodified API's source; PGFSM_SOURCE_URL overrides it. */
export const DEFAULT_SOURCE_URL = "https://github.com/pgfsm/fsm";

export interface LicenseNotice {
  /** SPDX identifier, e.g. AGPL-3.0-only. */
  license: string;
  /** Where the source of the running API can be obtained. */
  source: string;
}

export function licenseNotice(
  source: string = DEFAULT_SOURCE_URL,
): LicenseNotice {
  return { license: LICENSE_SPDX, source };
}
