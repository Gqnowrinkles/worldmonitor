# Non-Destructive Docker Build Design

## Problem

Coolify builds currently mutate `api/` in place before documentation/inventory generation. `docker/build-handlers.mjs` rebundles root-level `api/*.js` handlers over their source files. Later, `scripts/generate-inventory-facts.mjs` calls `scripts/docs-stats.mjs`, whose contracts parse pristine source text such as `api/bootstrap.js` and `api/health.js`. After bundling, those source layouts no longer exist, so Docker fails even though handler compilation succeeded.

The previous dependency-cycle fix correctly made `_inventory-facts.generated.js` external during handler bundling, but it did not remove the destructive write to `api/`.

## Goals

1. Keep repository source under `api/` byte-for-byte unchanged during Docker handler compilation.
2. Produce the same runtime handler tree in a separate build directory.
3. Let source attribution inspect both pristine source and compiled runtime bundles.
4. Generate inventory facts from pristine source after attribution has been refreshed.
5. Ensure the generated inventory module is present beside the compiled `product-catalog.js` runtime bundle.
6. Make the root Docker builder path a required pre-merge CI check so Coolify does not discover builder-order failures after merge.

## Non-goals

- No changes to API behavior, pricing, auth, billing, or production data.
- No source-attribution policy changes beyond including an optional build output tree when present.
- No change to Coolify configuration is required for this fix.
- Do not weaken `docs-stats` parsers to accept esbuild output.

## Architecture

`docker/build-handlers.mjs` will create `build/api` as the runtime API tree. It will first copy the complete pristine `api/` tree into `build/api`, preserving helper modules and any non-code assets. It will then compile TypeScript handlers and root-level JavaScript handlers from `api/` and write their outputs to matching paths under `build/api` instead of overwriting source.

The build-generated inventory import remains external by import specifier so `build/api/product-catalog.js` retains `./_inventory-facts.generated.js`. After `scripts/source-attribution.mjs --write` and `scripts/generate-inventory-facts.mjs` complete against pristine source, Docker copies `api/_inventory-facts.generated.js` into `build/api/_inventory-facts.generated.js`.

`scripts/source-attribution.mjs` will add `build/api` to `SOURCE_ROOTS`. Its existing missing-directory-tolerant walker means normal source-only checks are unchanged when `build/api` does not exist. During Docker builds, attribution will see compiled bundle URLs as well as pristine source.

The final Docker stage will copy `/app/build/api` rather than `/app/api` into the runtime image.

## Data flow

1. `COPY . .` leaves repository source pristine.
2. `node docker/build-handlers.mjs` copies `api/` to `build/api` and overlays compiled handler bundles there.
3. `node scripts/source-attribution.mjs --write` scans `scripts`, `server`, `api`, `src`, and optional `build/api`.
4. `node scripts/generate-inventory-facts.mjs` parses pristine source and writes generated inventory outputs under the normal source paths.
5. Docker copies `api/_inventory-facts.generated.js` to `build/api/_inventory-facts.generated.js`.
6. Crawlable corpus, TypeScript, and Vite builds run.
7. Final image copies `build/api` to `/app/api`.

## Failure handling

- `build/api` is rebuilt from scratch each handler-build run to prevent stale artifacts.
- Any copy or esbuild failure exits nonzero.
- Inventory generation remains fail-closed.
- Source attribution remains fail-closed for real manifest errors.
- CI runs the actual root Docker builder stage to catch ordering, parser, generated-artifact, and bundle failures before merge.

## Tests

1. Add a focused regression test proving handler compilation targets `build/api` and leaves source `api/bootstrap.js` unchanged.
2. Verify generated runtime `product-catalog.js` keeps the inventory module as a relative external import.
3. Verify source attribution tolerates absent `build/api` and scans it when present through existing scanner behavior.
4. Run the actual root Docker builder in CI.
5. Verify the final PR diff does not alter runtime API semantics beyond build paths.
