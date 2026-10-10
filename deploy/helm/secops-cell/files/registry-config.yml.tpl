version: 0.1
log: { level: info }
storage:
  filesystem: { rootdirectory: /var/lib/registry }
  delete: { enabled: true }
http:
  addr: :5000
  headers: { X-Content-Type-Options: [nosniff] }
auth:
  token:
    realm: {{ printf "%s://%s/api/v1/registry/token" (include "cell.scheme" .) (include "cell.apiHost" .) | quote }}
    service: secops-registry
    issuer: secops-cell
    rootcertbundle: /certs/registry.crt
notifications:
  endpoints:
    - name: platform
      url: http://{{ .Release.Name }}-api:3000/api/v1/registry/events
      headers: { Authorization: ["Bearer {{ include "cell.registryEventsSecret" . }}"] }
      timeout: 5s
      threshold: 3
      backoff: 10s
      ignoredmediatypes: [application/octet-stream]
