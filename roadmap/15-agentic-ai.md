# Step 15 — Agentic AI ⏳

**Goal.** The 24/7 agentic security & compliance consultant: observe → analyze → recommend →
act → verify → report, operating only through the platform, inheriting the user's permissions,
every action auditable.

## Scope
* **Model-agnostic AI gateway:** Anthropic, OpenAI, other providers, private/on-prem models via an
  OpenAI-compatible endpoint; per-cell configuration; data stays in the cell unless opted in.
* **Internal MCP server** exposing the tool layer from the concept — `get_projects`,
  `get_project_details`, `get_vulnerabilities`, `analyze_vulnerability`, `get_sbom`,
  `compare_sboms`, `evaluate_policy`, `get_policy_violations`, `get_compliance_status`,
  `get_missing_controls`, `get_risks`, `get_incidents`, `create_remediation_task`,
  `generate_report`, `collect_evidence`, `get_security_score`, `trigger_security_job`,
  `search_platform_data` — each tool enforces RBAC and the action level; `approval_required`
  actions create approval requests.
* **Specialized agents** and an **orchestrator:** Security, Vulnerability, Product Security,
  Compliance, Policy, Evidence, Remediation, Incident, Audit, Support.
* **Consultant experiences:** security ("what should we fix first?"), compliance ("what are we
  missing for ISO 27001?"), support ("why did my runner fail?").
* **AI + runners:** user → agent → tool → RBAC → policy → job → scheduler → runner → results → explanation.
* **Proactive AI:** new KEV CVE → affected SBOMs → graph impact → exposure → remediation proposal →
  notify → rescan → verify → evidence.
* **AI audit trail:** agent, user, project, action, reason, runner/job, timestamp, result.
* UI: chat panel with citations to platform objects; approvals inbox; agent activity log.

## Acceptance criteria
- [ ] A developer's session cannot see or act outside their scope (test suite over all tools).
- [ ] "Rescan Payment API" creates a job through RBAC + policy + scheduler and explains results.
- [ ] Every AI action is in the audit trail with `AI_AGENT` actor and the initiating user.
- [ ] Switching the provider (Anthropic → local model) changes nothing in the tool layer.
