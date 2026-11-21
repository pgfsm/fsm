// The Activity Gateway's licence notice (SPEC-017). It is AGPL-3.0-only, and
// AGPL-3.0 §13 obliges whoever runs a modified version to offer its source to
// the users who interact with it over a network. The gateway logs its licence
// and where its source is at startup; PGFSM_SOURCE_URL points that at a
// modified version's own source (the same variable @pgfsm/api reads).

/** The SPDX identifier of @pgfsm/async-worker-gateway's licence. */
export const LICENSE_SPDX = "AGPL-3.0-only";

/** The unmodified gateway's source; PGFSM_SOURCE_URL overrides it. */
export const DEFAULT_SOURCE_URL = "https://github.com/pgfsm/fsm";

export interface LicenseNotice {
  /** SPDX identifier, e.g. AGPL-3.0-only. */
  license: string;
  /** Where the source of the running gateway can be obtained. */
  source: string;
}

/** The notice for a gateway whose source is `sourceUrl` (empty: upstream). */
export function licenseNotice(sourceUrl?: string): LicenseNotice {
  return { license: LICENSE_SPDX, source: sourceUrl || DEFAULT_SOURCE_URL };
}
