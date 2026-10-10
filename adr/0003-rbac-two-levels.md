# ADR 0003 — Two-level access control (GitLab model)

**Status:** accepted · **Date:** 2026-09-18

## Decision

Access control has two levels, like GitLab's instance admins + group/project access levels.

1. **Cell level (instance).** Every user is `user` or `admin` (`users.platform_role`).
   *Administrators* see and can do everything in the cell and own the Administration area
   (users, and from step 02/03 on: integrations, runners, cell settings). *Users* see nothing
   until they hold a role somewhere. Admins can disable a user (they keep their memberships but
   cannot sign in). Bootstrap emails (`BOOTSTRAP_ADMIN_EMAILS`) become administrators on first
   sign-in and owners (`ORG_ADMIN`) of the root organization.
2. **Scoped level.** Memberships = user × role × scope at organization, workspace, team, project,
   service or environment. A role applies to its scope and everything below (groups → subgroups →
   projects); the effective permissions at a point are the union of all roles up the chain (GitLab's
   "highest access level wins"); nothing flows upward; a member can always *see* the path to what
   they own. Roles are the concept's eleven (`ORG_ADMIN` = owner of a subtree, `TEAM_LEAD` ≈
   maintainer, `DEVELOPER`, `READ_ONLY` ≈ reporter, plus the security/compliance roles).

## Why

* Enterprise expectation and a model every developer already understands.
* The cell admin is the operator's and customer IT's handle on the instance without granting
  organization roles that show up in security dashboards.
* Scoped roles keep least privilege for everyone else, including the AI (step 15 inherits them).

## Consequences

* `AccessContext.isPlatformAdmin` short-circuits `AuthorizationService`; every listing that filters
  by visibility automatically includes everything for admins.
* Guards must not assume an admin holds any membership; audit shows admin actions as the user.
* Cell-level actions (`user.*`) are audited without an organization id.
