# Step 13 — Templates / golden projects, security baselines, asset discovery ⏳

**Goal.** Make the secure path the default and find what is not managed.

## Scope
* **Templates / golden projects** (e.g. "Secure Java Microservice"): Git policies, mandatory scans,
  SBOM, SAST, SCA, container scanning, required approvals, compliance baseline, default policies;
  new projects created from a template inherit all of it.
* **Security baselines:** mandatory standards per organization; every project compared against the
  baseline continuously; drift shown and scored.
* **Asset discovery:** orphan repositories, unmanaged cloud resources, shadow services, unknown
  container images, unregistered applications — detected from integrations and Kubernetes/cloud
  inventories; one-click "adopt into project".

## Acceptance criteria
- [ ] A project created from a template has its policies, scan profile and controls active immediately.
- [ ] Baseline drift on a project appears in its score breakdown.
- [ ] A repository in the GitHub organization not attached to any service is listed as orphan.
