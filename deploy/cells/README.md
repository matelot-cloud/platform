# Cells

One values file per tenant cell, `<slug>.values.yaml`, written from `_template.values.yaml` by
`scripts/cell-provision.sh new` and applied by `scripts/cell-provision.sh apply`. This directory is the
inventory of cells: a cell exists in production when its file is here, and an upgrade is a change to its
file (image tags, replicas, backup settings) followed by `apply`.

Secrets never go into these files. Use `${VAR}` placeholders; `apply` fills them from the environment
(from your secret manager / CI secrets) into a temporary copy that is deleted afterwards.

See docs/cell-provisioning.md.
