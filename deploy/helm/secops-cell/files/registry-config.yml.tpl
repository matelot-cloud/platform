version: 0.1
log: { level: info }
storage:
  filesystem: { rootdirectory: /var/lib/registry }
  delete: { enabled: true }
http:
  addr: :5000
  headers: { X-Content-Type-Options: [nosniff] }
{{- if and .Values.observability.metrics.enabled .Values.observability.metrics.exporters.enabled }}
  debug:
    addr: {{ printf ":%v" .Values.observability.metrics.exporters.registryPort | quote }}
    prometheus: { enabled: true, path: /metrics }
{{- end }}
auth:
  token:
    realm: {{ printf "%s://%s/api/v1/registry/token" (include "cell.scheme" .) (include "cell.apiHost" .) | quote }}
    service: secops-registry
    issuer: secops-cell
    rootcertbundle: /certs/registry.crt
notifications:
  endpoints:
    - name: platform
      url: http://{{ .Release.Name }}-api/api/v1/registry/events   # the api Service listens on 80
      headers: { Authorization: ["Bearer {{ include "cell.registryEventsSecret" . }}"] }
      timeout: 5s
      threshold: 3
      backoff: 10s
      ignoredmediatypes: [application/octet-stream]
