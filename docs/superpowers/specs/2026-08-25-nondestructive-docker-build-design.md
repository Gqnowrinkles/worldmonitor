# Non-Destructive Docker Build Design

## Problem

Coolify builds currently mutate `api/` in place before documentation/inventory generation. `docker/build-handlers.mjs` rebundles root-level `api/*.js` handlers over their source files. Later, `scripts/generate-inventory-facts.mjs` calls `scripts/docs-stats.mjs`, whose contracts parse pristine source text such as `api/bootstrap.js` and `api/health.js`. After bundling, those source layouts no longer exist, so Docker fails even though handler compilation succeeded.

The previous dependency-cycle fix correctly made `_inventory-facts.generated.js` external during handler bundling, but it did not remove the destructive write to `api/`.

## Goals

1. Keep repository source under `api/` byte-for-byte unchanged during Docker handler compilation.
2. Produce the runtime handler tree in a separate build directory.
3. Let the existing source-attribution walker inspect both pristine source and compiled runtime bundles without changing its policy surface.
4. Generate inventory facts from pristine source after attribution has been refreshed.
5. Ensure the generated inventory module is present beside the compiled `product-catalog.js` runtime bundle.
6. Make the root Docker builder path a required pre-merge CI check so Coolify does not discover builder-order failures after merge.

## Non-goals

- No changes to API behavior, pricing, auth, billing, or production data.
- No source-attribution policy change.
- No change to Coolify configuration is required for this fix.
- Do not weaken `docs-stats` parsers to accept esbuild output.

## Architecture

`docker/build-handlers.mjs` creates `build/api` as the runtime API tree. It first copies the complete pristine `api/` tree into `build/api`, preserving helper modules and non-code assets. It then compiles TypeScript handlers and root-level JavaScript handlers from `api/` and writes their outputs to matching paths under `build/api` instead of overwriting source.

The build-generated inventory import remains external by import specifier so `build/api/product-catalog.js` retains `./_inventory-facts.generated.js` even though the output directory moved.

The source-attribution walker already scans `api/` recursively, while `docs-stats` excludes dot-prefixed top-level API entries from its endpoint count and reads its source contracts from exact non-hidden paths. `build-handlers` therefore mirrors the completed runtime tree to `api/.runtime-scan`. Attribution sees compiled-bundle URL evidence through that hidden mirror, while source parsers continue reading pristine `api/bootstrap.js`, `api/health.js`, and other source files. The mirror is build-only and is removed before TypeScript/Vite compilation.

After `scripts/source-attribution.mjs --write` and `scripts/generate-inventory-facts.mjs` complete against this stable tree, Docker copies `api/_inventory-facts.generated.js` into `build/api/_inventory-facts.generated.js`.

The final Docker stage copies `/app/build/api` rather than `/app/api` into the runtime image.

## Data flow

1. `COPY . .` leaves repository source pristine.
2. `node docker/build-handlers.mjs` copies `api/` to `build/api`, overlays compiled handler bundles there, and mirrors that runtime tree to `api/.runtime-scan` for attribution only.
3. `node scripts/source-attribution.mjs --write` scans its normal roots; recursive `api/` traversal naturally includes `api/.runtime-scan`.
4. `node scripts/generate-inventory-facts.mjs` parses pristine source and writes generated inventory outputs under the normal source paths.
5. Docker copies `api/_inventory-facts.generated.js` to `build/api/_inventory-facts.generated.js`.
6. Crawlable/content corpus validation runs while the attribution mirror remains present.
7. Docker removes `api/.runtime-scan`, then TypeScript and Vite build.
8. Final image copies `build/api` to `/app/api`.

## Failure handling

- `build/api` and `api/.runtime-scan` are rebuilt from scratch each handler-build run to prevent stale artifacts.
- Any copy or esbuild failure exits nonzero.
- Inventory generation remains fail-closed.
- Source attribution remains fail-closed for real manifest errors.
- CI runs the actual root Docker builder stage to catch ordering, parser, generated-artifact, and bundle failures before merge.

## Tests

1. A focused regression test requires handler compilation to target `build/api` rather than source entrypoints.
2. Node syntax-checks `docker/build-handlers.mjs` before Docker executes it.
3. The actual root Docker builder runs in the required PR safety gate.
4. The Docker builder verifies source attribution, inventory generation, corpus generation, TypeScript, and Vite in the same order Coolify uses.
5. Final PR review verifies no runtime API semantic change beyond build paths and generated-artifact placement.
