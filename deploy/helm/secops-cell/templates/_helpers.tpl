{{/* Labels of every pod template: nothing here may depend on an image tag or the chart version, otherwise a release of
     the api image rolls Postgres, Keycloak, Redis and the registry too. */}}
{{- define "cell.podLabels" -}}
app.kubernetes.io/part-of: secops-platform
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
secops.io/tenant: {{ .Values.tenant.slug }}
{{- end -}}

{{/* Common labels of top-level objects: the pod labels plus version and chart. */}}
{{- define "cell.labels" -}}
{{ include "cell.podLabels" . }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "cell.scheme" -}}
{{- ternary "https" "http" .Values.ingress.tls -}}
{{- end -}}

{{- define "cell.apiHost" -}}
{{- printf "%s.%s" .Values.tenant.slug .Values.tenant.domain -}}
{{- end -}}

{{- define "cell.authHost" -}}
{{- printf "auth-%s.%s" .Values.tenant.slug .Values.tenant.domain -}}
{{- end -}}

{{- define "cell.image" -}}
{{- printf "%s:%s" .Values.image.repository (.Values.image.tag | default .Chart.AppVersion) -}}
{{- end -}}

{{- define "cell.databaseUrl" -}}
{{- if .Values.postgres.bundled -}}
{{- printf "postgresql://%s:%s@%s-postgres:5432/%s" .Values.postgres.username .Values.postgres.password .Release.Name .Values.postgres.database -}}
{{- else -}}
{{- required "postgres.externalUrl is required when postgres.bundled=false" .Values.postgres.externalUrl -}}
{{- end -}}
{{- end -}}

{{- define "cell.keycloakJdbcUrl" -}}
{{- if .Values.postgres.bundled -}}
{{- printf "jdbc:postgresql://%s-postgres:5432/%s" .Release.Name .Values.postgres.keycloakDatabase -}}
{{- else -}}
{{- required "postgres.externalKeycloakJdbcUrl is required when postgres.bundled=false" .Values.postgres.externalKeycloakJdbcUrl -}}
{{- end -}}
{{- end -}}

{{- define "cell.redisUrl" -}}
{{- if .Values.redis.bundled -}}
{{- printf "redis://%s-redis:6379" .Release.Name -}}
{{- else -}}
{{- required "redis.externalUrl is required when redis.bundled=false" .Values.redis.externalUrl -}}
{{- end -}}
{{- end -}}

{{/* Public Keycloak base URL, as browsers reach it */}}
{{- define "cell.keycloakPublicUrl" -}}
{{- if .Values.keycloak.bundled -}}
{{- printf "%s://%s" (include "cell.scheme" .) (include "cell.authHost" .) -}}
{{- else -}}
{{- required "keycloak.externalUrl is required when keycloak.bundled=false" .Values.keycloak.externalUrl -}}
{{- end -}}
{{- end -}}

{{/* Public issuer: what ends up in the `iss` claim */}}
{{- define "cell.keycloakIssuer" -}}
{{- if .Values.keycloak.bundled -}}
{{- printf "%s/realms/%s" (include "cell.keycloakPublicUrl" .) .Values.keycloak.realm -}}
{{- else -}}
{{- .Values.keycloak.externalIssuer | default (printf "%s/realms/%s" (include "cell.keycloakPublicUrl" .) .Values.keycloak.realm) -}}
{{- end -}}
{{- end -}}

{{/* Where the API fetches signing keys: in-cluster when bundled */}}
{{- define "cell.keycloakJwksUri" -}}
{{- if .Values.keycloak.bundled -}}
{{- printf "http://%s-keycloak:8080/realms/%s/protocol/openid-connect/certs" .Release.Name .Values.keycloak.realm -}}
{{- else -}}
{{- .Values.keycloak.externalJwksUri | default (printf "%s/protocol/openid-connect/certs" (include "cell.keycloakIssuer" .)) -}}
{{- end -}}
{{- end -}}

{{- define "cell.productName" -}}
{{- .Values.web.productName | default (printf "%s Security Platform" .Values.tenant.name) -}}
{{- end -}}

{{/*
Generated secrets (encryption key, registry events secret + token key pair, managed-runner secret) are resolved ONCE per
render and remembered in .Values._generated: values first, else the existing Secret (kept across upgrades through
lookup), else generated. Every include then returns the same value, so the Secret, the registry config and the pod
checksums agree, and an install renders exactly what the next upgrade renders (no spurious rollout).
*/}}
{{- define "cell.generated" -}}
{{- /* args: dict "ctx" . "name" <key> "value" <explicit value or ""> "secret" <Secret name> "key" <data key> "gen" <generator output> */ -}}
{{- $ctx := .ctx -}}
{{- if not (hasKey $ctx.Values "_generated") -}}{{- $_ := set $ctx.Values "_generated" dict -}}{{- end -}}
{{- $cache := index $ctx.Values "_generated" -}}
{{- if not (hasKey $cache .name) -}}
{{- $value := .value -}}
{{- if not $value -}}
{{- $existing := (lookup "v1" "Secret" $ctx.Release.Namespace (printf "%s-%s" $ctx.Release.Name .secret)) -}}
{{- if and $existing $existing.data (index $existing.data .key) -}}{{- $value = index $existing.data .key | b64dec -}}{{- end -}}
{{- end -}}
{{- if not $value -}}{{- $value = .gen -}}{{- end -}}
{{- $_ := set $cache .name $value -}}
{{- end -}}
{{- index $cache .name -}}
{{- end -}}

{{- define "cell.encryptionKey" -}}
{{- include "cell.generated" (dict "ctx" . "name" "encryptionKey" "value" .Values.encryptionKey "secret" "cell-key" "key" "CELL_ENCRYPTION_KEY" "gen" (randAlphaNum 64 | lower | regexFind "[0-9a-f]{64}" | default (printf "%s%s" (randNumeric 32) (randNumeric 32)))) -}}
{{- end -}}

{{/* registry-<slug>.<domain>: same shape as auth-<slug>.<domain>, so one wildcard certificate covers the cell. */}}
{{- define "cell.registryHost" -}}
{{- if .Values.registry.host -}}{{ .Values.registry.host }}{{- else -}}{{ printf "registry-%s.%s" .Values.tenant.slug .Values.tenant.domain }}{{- end -}}
{{- end -}}

{{- define "cell.registryEventsSecret" -}}
{{- include "cell.generated" (dict "ctx" . "name" "registryEventsSecret" "value" .Values.registry.eventsSecret "secret" "registry" "key" "REGISTRY_EVENTS_SECRET" "gen" (randAlphaNum 48)) -}}
{{- end -}}

{{/* Key + certificate pair as JSON {key, cert}: the API signs with the key, the registry trusts the certificate. */}}
{{- define "cell.registryKeyPair" -}}
{{- $explicit := "" -}}
{{- if and .Values.registry.tokenKey .Values.registry.tokenCert -}}{{- $explicit = dict "key" .Values.registry.tokenKey "cert" .Values.registry.tokenCert | toJson -}}{{- end -}}
{{- $existing := "" -}}
{{- if not $explicit -}}
{{- $s := (lookup "v1" "Secret" .Release.Namespace (printf "%s-registry" .Release.Name)) -}}
{{- if and $s $s.data (index $s.data "registry.key") (index $s.data "registry.crt") -}}{{- $existing = dict "key" (index $s.data "registry.key" | b64dec) "cert" (index $s.data "registry.crt" | b64dec) | toJson -}}{{- end -}}
{{- end -}}
{{- $c := genSelfSignedCert "secops-registry-token" nil nil 3650 -}}
{{- include "cell.generated" (dict "ctx" . "name" "registryKeyPair" "value" (coalesce $explicit $existing) "secret" "registry" "key" "__none__" "gen" (dict "key" $c.Key "cert" $c.Cert | toJson)) -}}
{{- end -}}

{{- define "cell.managedRunnerSecret" -}}
{{- include "cell.generated" (dict "ctx" . "name" "managedRunnerSecret" "value" .Values.managedRunners.secret "secret" "managed-runner" "key" "MANAGED_RUNNER_SECRET" "gen" (randAlphaNum 48)) -}}
{{- end -}}

{{- define "cell.workerImage" -}}
{{- printf "%s:%s" .Values.worker.image.repository (.Values.worker.image.tag | default .Chart.AppVersion) -}}
{{- end -}}

{{- define "cell.runnerImage" -}}
{{- printf "%s:%s" .Values.managedRunners.image.repository (.Values.managedRunners.image.tag | default .Chart.AppVersion) -}}
{{- end -}}
