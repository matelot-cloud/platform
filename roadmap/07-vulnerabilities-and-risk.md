# Step 07 — Vulnerability management & risk engine ⏳

**Goal.** Correlate components with vulnerability intelligence, determine everything the concept
lists per vulnerability (component, version, repository, product, image, deployment,
environment, production exposure, responsible team, severity, contextual risk, remediation
status) and score risk with more than CVSS.

## Scope
* Sources mirrored into the cell by a scheduled worker: OSV (purl-based), NVD (CVSS, CWE),
  CISA KEV (active exploitation), EPSS; offline bundle import for air-gapped cells.
* Correlation SBOM × vulnerability ranges → vulnerability findings, enriched through the catalog
  (image, deployment, environment, team).
* States: open, in progress, fixed (verified by rescan), accepted (exception, step 08), false
  positive, not affected (VEX statement generated).
* **Risk engine** inputs: CVSS, exploit availability, active exploitation, internet exposure,
  production exposure, business criticality, customer impact, number of affected assets,
  environment, compensating controls, remediation status → risk level + score + explanation.
  Same CVE: development → medium; production internet-facing → critical.
* "Which products are affected by CVE-X?" across the organization (precursor of the graph).

## Data model
`vulnerabilities`, `vulnerability_aliases`, `vulnerable_ranges`, `findings` (shared),
`finding_events`, `risk_scores`, `vex_statements`.

## Acceptance criteria
- [ ] New SBOM → vulnerability findings within 1 minute; risk re-scored when exposure changes.
- [ ] KEV-listed CVE in a production internet-facing service is `critical` regardless of CVSS.
- [ ] `not_affected` with justification produces a VEX document.
