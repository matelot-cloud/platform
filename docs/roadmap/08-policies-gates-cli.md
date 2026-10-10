# Step 08 — Security policies, policy-as-code, exceptions, CI/CD gates, CLI ⏳

**Goal.** Policies at organization / workspace / team / project level, inherited, evaluated
automatically and inside pipelines, with controlled exceptions.

## Scope
* Policy engine on OPA/Rego. Built-in library covering the concept's list: no critical CVEs in
  production (`SEC-PROD-001`), SBOM required before release, mandatory security scanning,
  mandatory code review, branch protection required, approved dependencies only, approved
  licenses only, minimum test coverage, trusted container images only, mandatory MFA, mandatory
  encryption, required security controls; plus custom Rego policies.
* Inheritance and precedence rules; evaluation on events and on demand; violations with owner
  and state; explanations ("which policy blocked my pipeline?").
* Exceptions: request → approve (role-gated) → time-boxed → documented → automatically
  re-evaluated; all audited.
* **Gates:** `POST /gates/evaluate` for a commit/artifact/environment → PASS/FAIL with policy ids
  and reasons; results stored as evidence.
* **CLI `security`** (single-file Node build + GitHub Action): `scan`, `sbom`, `policy-check`,
  `compliance-check`, `project status`, `vulnerabilities`, `risk-check`; non-zero exit on FAIL.
* **AI action levels** (`automatic`, `controlled_write`, `approval_required`) and an approval
  requests model are introduced here and used by every later mutation.

## Acceptance criteria
- [ ] Organization + workspace + project policies apply together per the documented precedence.
- [ ] A pipeline using the CLI fails on a critical CVE in a production artifact and passes after an approved exception; expiry re-opens the violation.
- [ ] The gate result explains exactly which policy and finding blocked deployment.
