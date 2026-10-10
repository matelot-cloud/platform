#!/usr/bin/env bash
# Decommission a tenant cell: final backup (downloaded), helm uninstall; the namespace and its data volumes
# (Postgres, registry blobs, backups) stay. With --purge the namespace is deleted with every volume — also after an
# earlier plain decommission, when only the namespace and volumes are left.
#   scripts/cell-decommission.sh --slug globex [--backup-dir ./decommissioned/globex] [--purge] [--yes]
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib/wait.sh
source scripts/lib/wait.sh
SLUG=""; DIR=""; PURGE=0; YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --slug) SLUG="$2"; shift 2;;
    --backup-dir) DIR="$2"; shift 2;;
    --purge) PURGE=1; shift;;
    -y|--yes) YES=1; shift;;
    *) echo "unknown argument: $1" >&2; sed -n '2,5p' "$0"; exit 1;;
  esac
done
[ -n "$SLUG" ] || { echo "--slug is required" >&2; exit 1; }
RELEASE="$SLUG"; NAMESPACE="tenant-$SLUG"; DIR="${DIR:-./decommissioned/$SLUG}"
K=(kubectl -n "$NAMESPACE")

# the cluster first: "no release" means nothing when kubectl cannot even reach it
CONTEXT="$(kubectl config current-context 2>/dev/null || true)"
[ -n "$CONTEXT" ] || { echo "no kubectl context is set (kubectl config use-context …)" >&2; exit 1; }
kubectl get --raw /readyz --request-timeout=10s > /dev/null 2>&1 || { echo "cluster of context '$CONTEXT' is unreachable" >&2; exit 1; }
kubectl get namespace "$NAMESPACE" > /dev/null 2>&1 || { echo "no namespace $NAMESPACE on '$CONTEXT': nothing to decommission" >&2; exit 1; }
HAS_RELEASE=0; STATUS=""
if STATUS="$(helm status "$RELEASE" -n "$NAMESPACE" -o json 2>/dev/null | sed -n 's/.*"status":"\([a-z-]*\)".*/\1/p' | head -1)" && [ -n "$STATUS" ]; then HAS_RELEASE=1; fi
# never pull the rug from under a running helm operation (apply's --wait, a rollback…)
case "$STATUS" in pending-*|uninstalling)
  echo "a helm operation is in progress on $RELEASE (status $STATUS); wait for it or check: helm history $RELEASE -n $NAMESPACE" >&2; exit 1;;
esac

echo "cell $SLUG on '$CONTEXT': namespace $NAMESPACE, release $RELEASE $([ "$HAS_RELEASE" = 1 ] && echo "present ($STATUS)" || echo 'already uninstalled')"
echo "volumes:"; "${K[@]}" get pvc --no-headers 2>/dev/null | awk '{print "   " $1 " (" $4 ", " $2 ")"}'
if [ "$HAS_RELEASE" = 0 ] && [ "$PURGE" = 0 ]; then
  echo "the release is already gone; only the namespace and its volumes remain. Use --purge to delete them."; exit 0
fi
if [ "$YES" != 1 ]; then
  echo
  if [ "$PURGE" = 1 ]; then echo "This DELETES namespace $NAMESPACE with every volume above (databases, registry blobs, backups on the PVC)."
  else echo "This takes the cell down (helm uninstall); the namespace and the volumes above are kept."; fi
  read -r -p "Type the slug to continue: " a
  [ "$a" = "$SLUG" ] || { echo "aborted: slug did not match, nothing was changed"; exit 1; }
fi

if [ "$HAS_RELEASE" = 1 ]; then
  if "${K[@]}" get cronjob "$RELEASE-backup" > /dev/null 2>&1; then
    echo "== final backup → $DIR"
    bash scripts/cell-backup.sh -r "$RELEASE" -n "$NAMESPACE" -d "$DIR"
  else
    echo "== no backup CronJob in this cell (backup.enabled was false): no final archive" >&2
    if [ "$PURGE" = 1 ] && [ "$YES" != 1 ]; then read -r -p "Purge anyway, losing the data? [y/N] " a; [ "$a" = y ] || { echo "aborted, nothing was changed"; exit 1; }; fi
  fi
  echo "== helm uninstall $RELEASE"
  helm uninstall "$RELEASE" -n "$NAMESPACE" --wait
else
  echo "== release already uninstalled: no final backup possible (nothing is running); purging what is left"
fi

if [ "$PURGE" = 1 ]; then
  echo "== deleting namespace $NAMESPACE (volumes included)"
  PVS="$("${K[@]}" get pvc -o jsonpath='{range .items[*]}{.spec.volumeName}{"\n"}{end}' 2>/dev/null | grep . || true)"
  kubectl delete namespace "$NAMESPACE" --wait=true
  # shellcheck disable=SC2086
  if ! wait_pvs 180 $PVS; then
    for pv in $PVS; do kubectl get pv "$pv" > /dev/null 2>&1 && echo "   PV $pv still exists ($(kubectl get pv "$pv" -o jsonpath='{.spec.persistentVolumeReclaimPolicy}') reclaim policy): delete it by hand if its data is not wanted" >&2; done
  fi
  echo "cell $SLUG purged. Keep $DIR (final archive) according to the data-retention agreement, then delete it."
else
  echo "cell $SLUG is down. Kept in $NAMESPACE:"
  "${K[@]}" get pvc --no-headers 2>/dev/null | awk '{print "   " $1 " (" $4 ")"}'
  "${K[@]}" get secret -l "app.kubernetes.io/instance=$RELEASE" --no-headers 2>/dev/null | awk '{print "   secret " $1}'
  echo "to remove everything later: scripts/cell-decommission.sh --slug $SLUG --purge"
fi
echo "remember: remove deploy/cells/$SLUG.values.yaml, DNS records, the S3 prefix (after retention) and the pull-secret / IdP client on the customer side."
