# Step 09 — Remediation, SLAs, Jira sync, notifications & escalation ⏳

**Goal.** Findings and violations become tracked, owned, deadline-bound work that is verified by
rescan and closed with evidence; people are told at the right time.

## Scope
* Remediation flow from the concept: identify project → find owner → create remediation → assign
  team → apply SLA → track → new build → rescan → verify → store evidence → close.
* Auto-creation rules (e.g. every critical in production) and manual creation.
* **SLAs** per organization/workspace/project by severity (critical 24 h, high 7 d, medium 30 d,
  low 90 d); overdue tracking; SLA compliance metrics.
* **Escalation ladders** (day 0 developer → day 2 team lead → day 5 security → day 7 CISO).
* **Notifications:** email (SMTP), Slack, Microsoft Teams, generic webhook/alerting; per-user and
  per-team preferences; digests.
* **Jira integration** (connected resource per project): create/sync issues two-way; other issue
  trackers through the same adapter interface.

## Acceptance criteria
- [ ] Critical finding in production → remediation task, Jira issue and Slack message within a minute.
- [ ] Fix pushed → rescan → finding fixed → task and Jira issue closed with evidence link, automatically.
- [ ] Overdue task escalates per the ladder; SLA dashboard shows compliance per team.
