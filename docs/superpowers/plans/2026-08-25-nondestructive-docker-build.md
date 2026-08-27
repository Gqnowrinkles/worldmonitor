# Non-Destructive Docker Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the root Docker build non-destructive and prove the same builder path in CI before merge.

**Architecture:** Preserve `api/` as source-of-truth, copy it to `build/api`, and compile handler entrypoints into that runtime tree. Source attribution scans optional `build/api`; inventory generation continues parsing pristine source; Docker copies the generated inventory module into the runtime tree before the final image copies `build/api` to `/app/api`.

**Tech Stack:** Node.js 24, esbuild, Docker BuildKit, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-25-nondestructive-docker-build-design.md`

## Global Constraints

- Do not push implementation directly to `main`; use PR only.
- Preserve runtime API behavior; change build paths only.
- `api/` must remain pristine after handler compilation.
- `build/api` must be disposable and rebuilt from scratch.
- `_inventory-facts.generated.js` must remain a runtime external import in `product-catalog.js`.
- `scripts/generate-inventory-facts.mjs` must continue to parse pristine source and fail closed.
- The actual root `Dockerfile` builder stage must run in PR CI.

---

### Task 1: Add the non-destructive handler-build regression

**Files:**
- Modify: `tests/build-handlers-syntax.test.mjs`

**Interfaces:**
- Consumes: `docker/build-handlers.mjs` as the executable under test.
- Produces: assertions that the script declares a separate runtime output root and does not bundle handlers back onto source paths.

- [ ] **Step 1: Add a failing structural regression**

Extend the existing syntax test with assertions over the script source:

```js
const BUILD_HANDLERS_SOURCE = readFileSync(BUILD_HANDLERS, 'utf8');
assert.match(BUILD_HANDLERS_SOURCE, /const runtimeApiRoot = path\.join\(projectRoot, 'build', 'api'\)/);
assert.doesNotMatch(BUILD_HANDLERS_SOURCE, /outfile\s*=\s*entryPoint\.replace/);
```

- [ ] **Step 2: Run the focused test on the pre-fix branch**

Run in CI or a checkout with dependencies available:

```bash
node --test tests/build-handlers-syntax.test.mjs
```

Expected: FAIL because `runtimeApiRoot` does not exist and the current script writes output to the source entrypoint path.

- [ ] **Step 3: Commit the failing test**

```bash
git add tests/build-handlers-syntax.test.mjs
git commit -m "test(build): require non-destructive handler output"
```

### Task 2: Make handler compilation non-destructive

**Files:**
- Modify: `docker/build-handlers.mjs`

**Interfaces:**
- Consumes: source tree `api/`.
- Produces: complete runtime tree `build/api/` with compiled handler entrypoints overlaid on a copy of source.

- [ ] **Step 1: Add runtime output tree setup**

Import `cp` and `rm` from `node:fs/promises`, define:

```js
const runtimeApiRoot = path.join(projectRoot, 'build', 'api');
```

Before discovering handlers:

```js
await rm(runtimeApiRoot, { recursive: true, force: true });
await cp(apiRoot, runtimeApiRoot, { recursive: true });
```

- [ ] **Step 2: Map each source handler to a runtime outfile**

Replace source-path output with:

```js
function runtimeOutfile(entryPoint) {
  const relative = path.relative(apiRoot, entryPoint).replace(/\.ts$/, '.js');
  return path.join(runtimeApiRoot, relative);
}
```

Use `runtimeOutfile(entryPoint)` for every esbuild invocation.

- [ ] **Step 3: Externalize inventory facts by import specifier**

Replace path-based `external` matching with an esbuild plugin:

```js
const runtimeGeneratedExternalPlugin = {
  name: 'runtime-generated-externals',
  setup(buildContext) {
    buildContext.onResolve({ filter: /^\.\/_inventory-facts\.generated\.js$/ }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};
```

Pass `plugins: [runtimeGeneratedExternalPlugin]` so the emitted runtime bundle retains `./_inventory-facts.generated.js` independent of output directory.

- [ ] **Step 4: Run focused tests**

```bash
node --check docker/build-handlers.mjs
node --test tests/build-handlers-syntax.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docker/build-handlers.mjs tests/build-handlers-syntax.test.mjs
git commit -m "fix(build): emit handler bundles outside source tree"
```

### Task 3: Wire attribution and Docker runtime assembly

**Files:**
- Modify: `scripts/source-attribution.mjs`
- Modify: `Dockerfile`

**Interfaces:**
- Consumes: optional `build/api` runtime bundle tree.
- Produces: refreshed attribution that includes compiled-bundle hosts and final runtime API directory containing generated inventory facts.

- [ ] **Step 1: Extend source attribution roots**

Change:

```js
const SOURCE_ROOTS = ['scripts', 'server', 'api', 'src'];
```

to:

```js
const SOURCE_ROOTS = ['scripts', 'server', 'api', 'src', 'build/api'];
```

The existing walker already treats missing roots as empty, preserving source-only checks.

- [ ] **Step 2: Update Docker builder comments and generated-module assembly**

After inventory generation add:

```dockerfile
RUN cp api/_inventory-facts.generated.js build/api/_inventory-facts.generated.js
```

Update comments so `build-handlers` is documented as writing `build/api`, attribution scans both source and compiled runtime bundles, and inventory generation parses pristine source.

- [ ] **Step 3: Change final runtime copy**

Replace:

```dockerfile
COPY --from=builder /app/api ./api
```

with:

```dockerfile
COPY --from=builder /app/build/api ./api
```

- [ ] **Step 4: Run source-only checks**

```bash
node scripts/source-attribution.mjs --check
node scripts/generate-inventory-facts.mjs
node scripts/generate-inventory-facts.mjs --check
```

Expected: source-attribution behavior remains valid when `build/api` is absent; inventory generation reads pristine `api/` source.

- [ ] **Step 5: Run the real Docker builder**

```bash
docker build --target builder -f Dockerfile .
```

Expected: exit 0 through handler compilation, source-attribution write, inventory generation, corpus build, TypeScript, and Vite.

- [ ] **Step 6: Commit**

```bash
git add scripts/source-attribution.mjs Dockerfile
git commit -m "fix(build): preserve source through Docker inventory generation"
```

### Task 4: Make root Docker builder a required PR gate

**Files:**
- Modify: `.github/workflows/test.yml`

**Interfaces:**
- Consumes: root `Dockerfile` and repository source.
- Produces: required `docs-stats` job failure whenever the real Docker builder fails.

- [ ] **Step 1: Add Docker builder verification to `docs-stats`**

Append to the existing always-on `docs-stats` job:

```yaml
      - name: Root Docker builder completes
        run: docker build --target builder -f Dockerfile .
```

This keeps the existing required job name `docs-stats`, so no Deploy Gate contract expansion is required.

- [ ] **Step 2: Verify workflow syntax and PR checks**

Open a PR and confirm `Test / docs-stats` executes the Docker builder step. Expected: the step reaches exit 0 on the fixed branch.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci: gate PRs on root Docker builder"
```

### Task 5: Final verification and merge

**Files:**
- No new implementation files.

**Interfaces:**
- Consumes: complete PR head.
- Produces: evidence that the Coolify failure class is closed before merge.

- [ ] **Step 1: Compare branch to `main`**

Confirm changes are limited to design/plan docs, handler build output path, attribution root, Docker assembly, focused regression, and CI gate.

- [ ] **Step 2: Verify required checks**

Confirm at minimum:

- `Stacked Merge Guard`: success.
- `Security Audit`: success or unrelated pre-existing failure explicitly identified.
- `Test / docs-stats`: success, including `Root Docker builder completes`.
- Focused handler-build regression: success.

- [ ] **Step 3: Merge by PR with expected head SHA**

Use GitHub PR merge only; do not push directly to `main`.

- [ ] **Step 4: Verify post-merge deployment evidence**

Confirm Coolify imports the new merge SHA. Do not call production fixed until a Coolify log shows the root Docker build passing beyond the previous `generate-inventory-facts.mjs` failure and the deployment completes.
