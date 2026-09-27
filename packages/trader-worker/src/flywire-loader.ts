/**
 * FlyWire subgraph loader — Workers-compatible (no Node APIs).
 *
 * Loads the FAFB 783 artifact from the R2 binding (FLYWIRE_ARTIFACT) and decodes it into typed
 * arrays using the DecompressionStream-based pipeline from @fly/fly-brain. The decoded subgraph
 * is cached module-level so each isolate decodes the 1.32 MB artifact exactly once.
 *
 * DARK DEPLOY: this module is only reached when FLYWIRE_TOPOLOGY=true. When the flag is OFF,
 * loadSubgraph() is never called and the R2 binding may be absent.
 *
 * MEMORY: decode peak ~24.7 MB, retained ~2.6 MB (well within the 128 MB isolate budget).
 */

import { decodeFlyWireArtifact, type FlyWireSubgraph } from "@fly/fly-brain";

/** Module-level cache — one decode per isolate lifetime. */
let _cached: FlyWireSubgraph | null = null;

/**
 * Load + decode the FlyWire subgraph from R2. Async; cached after first call.
 *
 * @param r2 - The FLYWIRE_ARTIFACT R2 bucket binding (from Env).
 * @throws If the R2 binding is absent or the artifact key is missing.
 */
export async function loadSubgraph(r2: R2Bucket | undefined): Promise<FlyWireSubgraph> {
  if (_cached) return _cached;
  if (!r2) {
    throw new Error(
      "FLYWIRE_TOPOLOGY is enabled but FLYWIRE_ARTIFACT R2 binding is not configured. " +
      "Add the R2 bucket binding to wrangler.toml before enabling the flag."
    );
  }
  const obj = await r2.get("fafb783-mb-cx.bin.gz.b64");
  if (!obj) {
    throw new Error(
      "FlyWire artifact 'fafb783-mb-cx.bin.gz.b64' not found in R2 bucket. " +
      "Upload it with: wrangler r2 object put FLYWIRE_ARTIFACT/fafb783-mb-cx.bin.gz.b64 --file=packages/fly-brain/src/connectome-data/fafb783-mb-cx.bin.gz.b64"
    );
  }
  const b64 = await obj.text();
  _cached = await decodeFlyWireArtifact(b64.trim());
  return _cached;
}

/** Reset the module-level cache (for testing / memory measurement). */
export function resetSubgraphCache(): void {
  _cached = null;
}

/** Whether the subgraph is already cached (for diagnostics). */
export function isSubgraphCached(): boolean {
  return _cached !== null;
}
