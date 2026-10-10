# Step 12 — Security graph, security score, role dashboards & trends ⏳

**Goal.** Answer "what is actually affected?" through the security/product graph, score every
level, and show each role the view the concept describes.

## Scope
* **Security graph** over the catalog (Postgres recursive queries + materialized edge table; a
  graph database only if measured necessary): product → service → repository → build → container
  → library → deployment → environment. Queries: CVE impact (repositories, images, products,
  production deployments), blast radius of a deployment, ownership paths.
* **Security score** for project / team / organization from vulnerabilities, policy violations,
  risk exposure, remediation speed, incidents, compliance status, missing evidence, baselines —
  with an explained breakdown (`Payment API 86/100: critical 0, high 3, violations 2, readiness 92%`).
* **Dashboards:** Developer (my projects, vulnerabilities, violations, tasks, pipelines); Team lead
  (team score, projects at risk, SLA violations, open vulnerabilities, remediation status);
  CISO/CTO (organization score, critical risks, compliance readiness, violations, open incidents,
  MTTR, trends, exposure). "What changed since yesterday?" feed.

## Acceptance criteria
- [ ] CVE impact query returns products/services/images/deployments in < 1 s at 10k components.
- [ ] Scores update within minutes; every deduction is explained.
- [ ] Each role's dashboard shows only what its RBAC scope allows.
