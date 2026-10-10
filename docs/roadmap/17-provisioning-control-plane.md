# Step 17 — Provisioning control plane, fleet operations, licensing ⏳

**Goal.** Operate many cells as a product: create, upgrade, monitor and bill them.

## Scope
* Provisioning service (separate deployment): customer registry, cell creation (`helm upgrade
  --install` per client with generated values and secrets), DNS/TLS, backups, restore drills.
* Version rollouts across the fleet (canary, waves), health and capacity monitoring, central
  alerting; per-cell usage metering and licensing (seats, projects, runner minutes).
* Shared GitHub App / marketplace listing for public-cloud customers; per-cell apps for enterprises.
* Runbooks and operator UI.

## Acceptance criteria
- [ ] A new customer cell is provisioned end to end in < 10 minutes and passes its smoke test.
- [ ] A fleet rollout upgrades cells in waves and halts on failed health checks.
