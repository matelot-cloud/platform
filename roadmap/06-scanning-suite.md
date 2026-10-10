# Step 06 — Security scanning suite & external scanner import ⏳

**Goal.** The runner workloads listed in the concept, producing *findings* in one normalized
model, plus import from the tools customers already run.

## Scope
* Runner job types with bundled open-source engines: **SCA** (from SBOM + vulnerability data,
  step 07), **SAST** (Semgrep), **secrets scanning** (Gitleaks), **IaC scanning** (Checkov /
  Trivy config), **container scanning** (Trivy / Grype), **Kubernetes checks** (kube-bench style
  configuration checks via the Kubernetes runner), **configuration analysis**, **license checks**,
  **artifact scanning**, **custom jobs** (customer script with results contract).
* **External scanner import:** SonarQube (issues, quality gate), Snyk, Trivy JSON, generic SARIF
  upload; deduplicated against native findings.
* Findings model shared with step 07: type (`vulnerability`, `sast`, `secret`, `iac`,
  `misconfiguration`, `license`), location (file/line, image layer, resource), tool, rule id,
  severity, fingerprint for dedup, state.
* Scan profiles per project/template (which scans run when).

## Data model
`scan_profiles`, `findings` (shared), `finding_locations`, `scanner_imports`.

## Acceptance criteria
- [ ] Each job type runs on a self-hosted runner in kind against a sample repository and produces findings.
- [ ] A SARIF upload and a native Semgrep run of the same rule produce one finding, not two.
- [ ] SonarQube import shows the quality gate status on the service.
