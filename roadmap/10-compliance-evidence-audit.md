# Step 10 — Continuous compliance: frameworks, controls, evidence automation, mapping engine, audit management ⏳

**Goal.** Continuous control status for CRA first, then NIS2, ISO 27001, SOC 2, DORA, PCI DSS,
CIS and further frameworks; evidence collected automatically and mapped once to many
requirements; auditors served with restricted access.

## Scope
* Versioned framework catalog: frameworks → requirements ↔ platform *controls*.
* Controls: technical (evaluated from platform data: branch protection, MFA in Keycloak, SBOM
  present, scans running, no critical CVEs in production, encryption settings…) and manual
  (attestations with owners and review cycles).
* **Evidence automation** from source control, CI/CD, cloud, Kubernetes, identity, scanners, Jira,
  runner results and platform activity; versioned, immutable, linked to controls and policies.
* **Mapping engine:** one control/evidence satisfies many requirements across frameworks (MFA →
  internal policy, ISO 27001, NIS2, SOC 2).
* Compliance readiness per framework / project; gap lists ("what are we missing for ISO 27001?").
* **Audit management:** auditor role & workspace: controls, policies, evidence, risks,
  vulnerabilities, exceptions, remediation history, compliance status, audit logs; evidence packs
  exported per audit.

## Acceptance criteria
- [ ] Enabling CRA shows control status within minutes with no manual input.
- [ ] Branch-protection evidence appears under the right CRA, ISO 27001 and NIS2 requirements at once.
- [ ] An auditor sees exactly the concept's list and nothing else; an evidence pack exports as a signed archive.
