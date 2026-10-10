# Step 04 — Catalog II: pipelines, builds, releases, images & registries, deployments, Kubernetes & cloud ⏳

**Goal.** Complete the product & software catalog of the concept:
Product → Service → Repository → Build → Release → Container → Dependency → Deployment →
Cloud Resource → Environment — kept current from the systems where these things happen.

## Scope
* **CI/CD:** GitHub Actions integration (workflow runs → *pipelines* and *builds* per service;
  status, commit, artifacts produced; "My Pipelines" for developers). Provider model reused by
  GitLab CI, Azure Pipelines, Jenkins in step 16.
* **Releases:** tags/releases from source control; release ↔ build ↔ SBOM (step 05) linkage.
* **Container images & registries:** registry integrations (GHCR, Docker Hub, ECR/ACR/GCR,
  private registries); image inventory with digests, tags, base images; image ↔ build ↔ service.
* **Kubernetes:** cluster connection via a *Kubernetes runner/agent* (step 03) that inventories
  namespaces, workloads, images in use → *deployments* mapped to environments.
* **Cloud:** AWS, Azure, GCP read-only inventory (accounts/subscriptions/projects, compute,
  serverless, storage, networking exposure) → *cloud resources* attached to environments; internet
  exposure feeds the risk engine.
* **Connected resources UI:** on a project, connect a Jira project (placeholder until step 09), a
  Kubernetes namespace, a cloud account, a registry, a pipeline — the concept's "Payment API"
  example.

## Data model
`pipelines`, `pipeline_runs`, `builds`, `releases`, `container_registries`, `container_images`,
`image_tags`, `kubernetes_clusters`, `deployments`, `cloud_accounts`, `cloud_resources`,
`connected_resources` (generic project ↔ external object link).

## Acceptance criteria
- [ ] A GitHub Actions run appears as a pipeline run on its service within 30 s; builds link to commits.
- [ ] An image pushed to a connected registry is inventoried with digest and linked to the build that produced it.
- [ ] A Kubernetes namespace connected to an environment shows its running images as deployments.
- [ ] An AWS account inventory marks internet-facing resources; environments inherit exposure.
