/**
 * The runtime version is deliberately a data-only seam. Build and install
 * glue use it to make the binary, checksum, and receipt provenance agree;
 * authority policy never depends on this value.
 */
export const AIRLOCK_VERSION = "0.1.0" as const
