# Roadmap — one document per step, covering the whole concept

> **Current focus: v1** — see [`v1.md`](v1.md) for the milestones we build now (M1–M12) and what is
> deferred. The steps below remain the long-term map; v1 milestones reference them.

Each step is a document in this folder: goal, scope, data model, API, UI, acceptance criteria and
a status we update as we go. A step is **done** when its acceptance criteria pass and the checks in
`CLAUDE.md` are green; only then does the next one start. The concept is `../concept.md`.

| # | Step | Status |
|---|------|--------|
| 01 | [Foundation: cell, core domain, auth, RBAC, audit, web app](01-foundation.md) | ✅ done |
| 02 | [Catalog I — services, environments, source control (GitHub App), connected resources](02-catalog-and-source-control.md) | ✅ done |
| 03 | [Execution plane — runners (cloud, self-hosted, Kubernetes, ephemeral), pools, tags, scheduler](03-runners-and-scheduler.md) | 🔨 slice 1 done |
| 04 | [Catalog II — CI/CD pipelines, builds, releases, container images & registries, deployments, Kubernetes & cloud resources](04-catalog-pipelines-artifacts-infra.md) | ⏳ |
| 05 | [SBOM management](05-sbom.md) | ⏳ |
| 06 | [Security scanning suite — SCA, SAST, secrets, IaC, container, Kubernetes, config, license; external scanner import](06-scanning-suite.md) | ⏳ |
| 07 | [Vulnerability management & risk engine](07-vulnerabilities-and-risk.md) | ⏳ |
| 08 | [Security policies, policy-as-code, exceptions, CI/CD gates, CLI](08-policies-gates-cli.md) | ⏳ |
| 09 | [Remediation, SLAs, Jira sync, notifications & escalation](09-remediation-sla-notifications.md) | ⏳ |
| 10 | [Continuous compliance — frameworks, controls, evidence automation, mapping engine, audit management](10-compliance-evidence-audit.md) | ⏳ |
| 11 | [Risk register, incident management, CRA/NIS2 reporting](11-risk-register-and-incidents.md) | ⏳ |
| 12 | [Security graph, security score, role dashboards & trends](12-graph-score-dashboards.md) | ⏳ |
| 13 | [Templates / golden projects, security baselines, asset discovery](13-templates-baselines-discovery.md) | ⏳ |
| 14 | [Public API, API keys, SDKs, GraphQL, outbound webhooks, automation endpoints](14-public-api-sdks-webhooks.md) | ⏳ |
| 15 | [Agentic AI — gateway, MCP tool layer, specialized agents & orchestrator, action levels, approvals, proactive flows, support agent, AI audit](15-agentic-ai.md) | ⏳ |
| 16 | [Enterprise identity (SCIM, Entra ID, Okta, SAML, MFA policies), MSSP/consultant mode, additional source-control & CI providers](16-enterprise-identity-mssp-providers.md) | ⏳ |
| 17 | [Provisioning control plane, fleet operations, licensing](17-provisioning-control-plane.md) | ⏳ |

## Coverage: every concept section → step

| Concept section | Step(s) |
|-----------------|---------|
| Platform structure (Organization → Workspaces → Teams → Projects → Services → Environments) | 01, 02 |
| Project-centric model (connected resources per project) | 02 (model, GitHub), 04 (pipelines, registries, Kubernetes, cloud), 06 (scanners), 09 (Jira) |
| Integrations — source code (GitHub, GitLab, Bitbucket, Azure DevOps) | 02 (GitHub), 16 (others) |
| Integrations — project management (Jira, others) | 09 |
| Integrations — CI/CD (GitHub Actions, GitLab CI, Azure Pipelines, Jenkins) | 04 (GitHub Actions), 16 (others) |
| Integrations — cloud (AWS, Azure, GCP) | 04 |
| Integrations — infrastructure (Kubernetes, Docker, registries, cloud environments) | 04 |
| Integrations — security tools (SonarQube, Snyk, Trivy, SAST/SCA/container/infra tools) | 06 |
| Integrations — identity (Entra ID, Okta, SAML, OIDC, SCIM, MFA) | 01 (OIDC/SAML via Keycloak), 16 |
| Integrations — notifications (Slack, Teams, email, alerting) | 09 |
| SaaS control plane (organizations… job scheduling, runner management) | 01–03 (the cell is the control plane), 17 (fleet) |
| Security runners, managed runners, self-hosted runners, runner types, pools, tags, secure runner architecture | 03 |
| Product & software catalog (product → service → repository → build → release → container → dependency → deployment → cloud resource → environment) | 02, 04, 05 |
| Security graph | 12 |
| SBOM management | 05 |
| Vulnerability management | 07 |
| Risk engine | 07 |
| Security policies, policy-as-code, policy exceptions | 08 |
| CI/CD security & compliance gates | 08 |
| CLI | 08 |
| API, SDKs, webhooks (REST, GraphQL, SDKs, automation endpoints) | 14 |
| Remediation management | 09 |
| Security SLA management | 09 |
| Notifications & escalation | 09 |
| RBAC | 01 (+ every step adds its permissions) |
| Enterprise identity | 16 |
| Continuous compliance, compliance mapping engine, evidence automation, audit management | 10 |
| Risk register | 11 |
| Incident management, CRA/NIS2 reporting support | 11 |
| Security dashboards (developer, team lead, CISO/CTO), security score | 12 |
| Templates / golden projects, security baselines | 13 |
| Asset discovery | 13 |
| Multi-tenant architecture (parent/subsidiaries, isolation) | 01 (cells + org hierarchy), 17 |
| Consultant / MSSP mode | 16 |
| Agentic AI: internal tool layer, security/compliance/support consultants, AI + runners, proactive AI, specialized agents, AI + RBAC, AI action permissions, AI audit trail, internal MCP layer, model-agnostic AI | 15 (rails prepared in 08–11) |
| Complete audit trail | 01 (+ every step) |

## Principles that hold across every step

* **Cell model.** Each client has a dedicated cell (`deploy/helm/secops-cell`) — the "SaaS control
  plane" of the concept is the cell's API. Runners connect *to* the cell. The provisioning control
  plane that creates and operates cells is step 17.
* **Every step ships with:** SQL migration, permissions in `permissions.ts`, audit events for every
  mutation, `/api/v1` endpoints, a page or section in `apps/web`, unit tests, and the jsdom render
  test kept green.
* **Runners execute, the cell decides.** From step 03 on, anything that touches customer code,
  artifacts or infrastructure runs as a runner job; the API never runs scanners itself.
* **AI arrives at step 15 but is designed in from the start:** `actor_type = AI_AGENT`, action
  levels (`automatic`, `controlled_write`, `approval_required`) and approval requests are modelled
  in steps 08–11, so step 15 adds agents, not safety rails.
