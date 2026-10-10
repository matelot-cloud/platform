# CRA-Native Product Security OS for European Software Companies (v1 focus)

The platform is a **B2B Product Security & Compliance SaaS built for European software, IoT,
embedded, and connected-product companies**. It helps engineering and security teams continuously
understand: what software products they have; what components and dependencies those products
contain; which vulnerabilities affect them; which releases and production environments are exposed;
what security policies are being violated; what needs to be fixed; what evidence is required for
CRA and other compliance frameworks.

**Product Security + CI/CD Security + CRA Compliance in one operational platform.** Not a generic
AppSec scanner, not a generic GRC platform.

## Core structure
Organization → Workspaces → Teams → Projects → Products / Services → Environments. Each project
connects its own repositories (GitHub / GitLab / Azure DevOps), CI/CD pipelines, Jira project,
container registries, Kubernetes environments, security tools, cloud resources.

## Product inventory
Product → Service → Repository → Build → Release → Container → Dependency → Deployment → Environment.

## SBOM management
Per product and release: components, dependency versions, transitive dependencies, licenses,
vulnerabilities, changes between releases (Product 4.1 → SBOM, 4.2 → SBOM, 4.3 → SBOM).

## Vulnerability management
Continuous correlation of vulnerability intelligence with customer products: which products,
versions, repositories, container images, environments are affected; whether production is exposed;
which team owns it. "CVE-X affects Product A versions 3.2 and 3.3, 6 repositories, 2 container
images, and the production Kubernetes deployment."

## Product Security Graph
Products → Services → Repositories → Builds → Components → Containers → Deployments → Environments
→ Vulnerabilities → Teams: the actual business and technical impact of a security issue.

## Risk analysis
CVSS, active exploitation, exploit availability, production exposure, internet exposure, product
criticality, environment, customer impact, compensating controls. Same vulnerability: development →
Medium; internet-facing production → Critical.

## Security policies
No Critical vulnerabilities in Production; SBOM required before release; security scan required;
approved dependencies / licenses only; container scan required; branch protection required;
mandatory code review. Inherited Organization → Workspace → Team → Project.

## CI/CD security gates
Push → Build → Tests → Security Scan → SBOM → Vulnerability Analysis → Policy Evaluation →
PASS / FAIL → Deployment. A violated policy blocks the pipeline with policy, component and CVE named.

## Security runners
Runners are the Execution Plane, the SaaS the Control Plane: scheduler → runner → scan → results.
Managed runners for smaller customers; self-hosted runners inside enterprise infrastructure (code
never has to leave; only findings, SBOM metadata and evidence come back; outbound HTTPS only, no
public IP).

## Remediation
Vulnerability detected → product impact → responsible team → remediation task → SLA → fix → new
build scanned → verified → evidence stored → finding closed. Jira integration.

## CRA-native compliance and continuous evidence
SBOM, vulnerability management, security update process, incident workflow, security testing,
remediation history → CRA evidence, collected continuously and versioned from repositories, CI/CD,
scans, runners, issue tracking, infrastructure, releases. Later: NIS2, ISO 27001, SOC 2, DORA.

## Agentic AI security consultant
24/7 consultant working only through platform tools and data, respecting RBAC: highest risks,
products affected by CVE-X, why a pipeline failed, what to fix first, missing CRA evidence, what
changed in 24 h. Controlled actions (analyze, prioritize, create remediation tasks, collect
evidence, generate reports, explain policy failures, trigger approved scans); sensitive actions
need human approval.

## Initial product scope
Workspaces / Projects → GitHub / GitLab integrations → Managed / Self-Hosted Runners → Product
Inventory → SBOM → Vulnerability Correlation → Product Security Graph → Risk Analysis → Security
Policies → CI/CD Security Gates → Remediation → CRA Evidence → Agentic AI Consultant.

Core lifecycle: **Code → Build → Runner → SBOM → Vulnerability → Product Impact → Risk → Policy →
Remediation → CRA Evidence → AI Automation.**

Initial customer: European company building its own software / IoT / embedded / connected products,
30–500 employees, several engineering teams, GitHub / GitLab / Azure DevOps, regular releases,
preparing for CRA.
