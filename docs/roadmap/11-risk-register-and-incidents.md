# Step 11 — Risk register, incident management, CRA/NIS2 reporting ⏳

**Goal.** A central risk register and an incident workflow with a complete timeline, feeding
regulatory reporting drafts for authorized review.

## Scope
* **Risk register:** description, impact, probability, owner, affected products, mitigation,
  evidence, review and expiration dates; states open / accepted / mitigated / transferred /
  closed; acceptance is approval-gated (`approval_required`) and audited.
* **Incidents:** detect → investigate → determine impact → assign → contain → remediate → report
  → preserve evidence → close; full timeline; links to findings, products, versions, deployments,
  customers affected.
* **CRA / NIS2 reporting support:** drafts (early warning, notification, final report) assembled
  from incident data; human review and approval before export (PDF/JSON).

## Acceptance criteria
- [ ] Accepting a major risk requires the approval role and records approver and reason.
- [ ] An incident timeline reconstructs every state change with who/when/why.
- [ ] A CRA early-warning draft generates from an incident and exports after approval.
