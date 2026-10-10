# Step 05 — SBOM management ⏳

**Goal.** Generate, import, store, version and diff Software Bills of Materials for every service,
build and release; know when a dependency was introduced, changed or removed.

## Scope
* Job type `sbom` executed by runners: Syft → CycloneDX 1.5 (SPDX import too). Sources: repository
  @ ref, container image, uploaded artifact.
* Triggers: manual, push to default branch, build completed, release created, schedule.
* Normalized components (purl, name, version, type), transitive dependency graph, licenses.
* History per service and per release: `v1.0 → SBOM`, `v1.1 → SBOM`; diff (added / removed /
  version changed); "when was X introduced?".
* Upload API for SBOMs produced elsewhere (CI, vendors); CLI `security sbom` (step 08).

## Data model
`sboms`, `components` (purl unique), `sbom_components` (scope, depth, direct/transitive),
`component_licenses`, `component_dependencies`.

## Acceptance criteria
- [ ] Push to default branch on an attached repository → SBOM within 2 minutes (runner online).
- [ ] Release-to-release diff lists every version change; component timeline answers "since when?".
- [ ] "Which services contain lodash 4.17.20?" answers across the organization.
