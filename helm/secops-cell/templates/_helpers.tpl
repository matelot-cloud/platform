{{/* Common labels */}}
{{- define "cell.labels" -}}
app.kubernetes.io/part-of: secops-platform
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
secops.io/tenant: {{ .Values.tenant.slug }}
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

{{/* Reuse an existing generated secret value across upgrades, otherwise generate. */}}
{{- define "cell.encryptionKey" -}}
{{- if .Values.encryptionKey -}}
{{- .Values.encryptionKey -}}
{{- else -}}
{{- $existing := (lookup "v1" "Secret" .Release.Namespace (printf "%s-cell-key" .Release.Name)) -}}
{{- if and $existing $existing.data (index $existing.data "CELL_ENCRYPTION_KEY") -}}
{{- index $existing.data "CELL_ENCRYPTION_KEY" | b64dec -}}
{{- else -}}
{{- randAlphaNum 64 | lower | regexFind "[0-9a-f]{64}" | default (printf "%s%s" (randNumeric 32) (randNumeric 32)) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* registry-<slug>.<domain>: same shape as auth-<slug>.<domain>, so one wildcard certificate covers the cell. */}}
{{- define "cell.registryHost" -}}
{{- if .Values.registry.host -}}{{ .Values.registry.host }}{{- else -}}{{ printf "registry-%s.%s" .Values.tenant.slug .Values.tenant.domain }}{{- end -}}
{{- end -}}

{{/* Reuse generated registry secrets across upgrades. */}}
{{- define "cell.registryEventsSecret" -}}
{{- if .Values.registry.eventsSecret -}}{{ .Values.registry.eventsSecret }}{{- else -}}
{{- $existing := (lookup "v1" "Secret" .Release.Namespace (printf "%s-registry" .Release.Name)) -}}
{{- if and $existing $existing.data (index $existing.data "REGISTRY_EVENTS_SECRET") -}}{{ index $existing.data "REGISTRY_EVENTS_SECRET" | b64dec }}{{- else -}}{{ randAlphaNum 48 }}{{- end -}}
{{- end -}}
{{- end -}}

{{/* Key + certificate pair: the API signs with the key, the registry trusts the certificate. Reused across upgrades. */}}
{{- define "cell.registryKeyPair" -}}
{{- if and .Values.registry.tokenKey .Values.registry.tokenCert -}}
{{- dict "key" .Values.registry.tokenKey "cert" .Values.registry.tokenCert | toJson -}}
{{- else -}}
{{- $existing := (lookup "v1" "Secret" .Release.Namespace (printf "%s-registry" .Release.Name)) -}}
{{- if and $existing $existing.data (index $existing.data "registry.key") (index $existing.data "registry.crt") -}}
{{- dict "key" (index $existing.data "registry.key" | b64dec) "cert" (index $existing.data "registry.crt" | b64dec) | toJson -}}
{{- else -}}
{{- $c := genSelfSignedCert "secops-registry-token" nil nil 3650 -}}
{{- dict "key" $c.Key "cert" $c.Cert | toJson -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* Shared secret of the managed runners: values, else the existing Secret (kept across upgrades), else generated. */}}
{{- define "cell.managedRunnerSecret" -}}
{{- if .Values.managedRunners.secret -}}
{{- .Values.managedRunners.secret -}}
{{- else -}}
{{- $existing := (lookup "v1" "Secret" .Release.Namespace (printf "%s-managed-runner" .Release.Name)) -}}
{{- if and $existing $existing.data (index $existing.data "MANAGED_RUNNER_SECRET") -}}
{{- index $existing.data "MANAGED_RUNNER_SECRET" | b64dec -}}
{{- else -}}
{{- randAlphaNum 48 -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "cell.runnerImage" -}}
{{- printf "%s:%s" .Values.managedRunners.image.repository (.Values.managedRunners.image.tag | default .Chart.AppVersion) -}}
{{- end -}}
