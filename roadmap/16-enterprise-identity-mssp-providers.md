# Step 16 — Enterprise identity, MSSP/consultant mode, additional providers ⏳

**Goal.** Serve large enterprises and security providers, and cover the remaining integrations.

## Scope
* **Identity:** SCIM provisioning into Keycloak; Entra ID and Okta presets (OIDC/SAML); MFA
  policies enforced per organization; session and token policies; login audit.
* **MSSP / consultant mode:** a provider organization manages several customer organizations with
  strict data isolation, consolidated dashboards and per-customer reporting.
* **Source control:** GitLab (cloud and self-managed), Bitbucket, Azure DevOps on the step 02
  provider model. **CI/CD:** GitLab CI, Azure Pipelines, Jenkins on the step 04 model.
* Additional issue trackers and alerting platforms as adapters.

## Acceptance criteria
- [ ] A user deprovisioned in Entra ID loses access within the SCIM sync interval.
- [ ] An MSSP admin sees all customer organizations; a customer never sees another customer.
- [ ] A GitLab self-managed instance behind the customer firewall syncs through a self-hosted runner.
