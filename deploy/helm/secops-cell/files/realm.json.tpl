{
  "realm": {{ .Values.keycloak.realm | quote }},
  "displayName": {{ printf "%s Security Platform" .Values.tenant.name | quote }},
  "enabled": true,
  "sslRequired": {{ ternary "external" "none" .Values.ingress.tls | quote }},
  "registrationAllowed": false,
  "loginWithEmailAllowed": true,
  "duplicateEmailsAllowed": false,
  "bruteForceProtected": true,
  "accessTokenLifespan": 900,
  "clients": [
    {
      "clientId": {{ .Values.keycloak.audience | quote }},
      "name": "Platform API",
      "enabled": true,
      "protocol": "openid-connect",
      "bearerOnly": true,
      "publicClient": false
    },
    {
      "clientId": "platform-web",
      "name": "Platform Web",
      "enabled": true,
      "protocol": "openid-connect",
      "publicClient": true,
      "standardFlowEnabled": true,
      "directAccessGrantsEnabled": {{ .Values.keycloak.allowPasswordGrant }},
      "redirectUris": [
        {{ printf "%s://%s/*" (include "cell.scheme" .) (include "cell.apiHost" .) | quote }}
        {{- range .Values.keycloak.extraRedirectUris }},
        {{ . | quote }}
        {{- end }}
      ],
      "webOrigins": ["+"],
      "attributes": {
        "pkce.code.challenge.method": "S256",
        "post.logout.redirect.uris": "+"
      },
      "protocolMappers": [
        {
          "name": "platform-api-audience",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-audience-mapper",
          "consentRequired": false,
          "config": {
            "included.client.audience": {{ .Values.keycloak.audience | quote }},
            "id.token.claim": "false",
            "access.token.claim": "true"
          }
        }
      ]
    }
  ],
  "users": [
    {{- range $i, $u := .Values.keycloak.seedUsers }}
    {{- if $i }},{{ end }}
    {
      "username": {{ $u.username | quote }},
      "email": {{ $u.email | quote }},
      "emailVerified": true,
      "enabled": true,
      "firstName": {{ $u.firstName | default "" | quote }},
      "lastName": {{ $u.lastName | default "" | quote }},
      "credentials": [{ "type": "password", "value": {{ $u.password | quote }}, "temporary": false }]
    }
    {{- end }}
  ]
}
