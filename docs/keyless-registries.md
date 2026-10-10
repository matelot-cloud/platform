# Keyless registry connections (workload identity federation)

Matelot can pull from Google Artifact Registry, Amazon ECR and Azure Container Registry
without storing a cloud secret. The platform is an OIDC identity provider; each connection
gets its own identity, and the cloud trusts tokens Matelot signs for it.

## How it works
- Issuer: `API_PUBLIC_URL` (must be public HTTPS — the cloud fetches the discovery document and keys).
- Discovery: `<issuer>/.well-known/openid-configuration`, keys: `<issuer>/.well-known/jwks.json`.
- Tokens: RS256, 10-minute lifetime, `sub = integration:<connection id>`, one audience per cloud.
- The signing key is stored encrypted with the cell key. If it can no longer be decrypted
  (cell key changed) a new key is generated; the old public key stays in the JWKS as retired.

| Cloud | Auth type | Audience | Exchange |
|---|---|---|---|
| GCP (GAR) | `gcp_wif` | `https://iam.googleapis.com/<provider resource>` | STS token exchange → `generateAccessToken` for the service account → docker user `oauth2accesstoken` |
| AWS (ECR) | `aws_wif` | `sts.amazonaws.com` | `AssumeRoleWithWebIdentity` → temporary keys → ECR `GetAuthorizationToken` |
| Azure (ACR) | `azure_wif` | `api://AzureADTokenExchange` | Entra ID client credentials with a client assertion → ACR refresh token |

## Setting it up
The cloud trusts the **exact** subject `integration:<connection id>`, and the id only exists once the connection
is created. So a keyless connection is created first, unverified, and checked afterwards:

1. **Create** the connection with **Keyless** on (web: Connect → registry → Keyless), or via CLI
   `matelot connection create --body '{"provider":"registry","baseUrl":"…","auth":{"type":"aws_wif","roleArn":"…","region":"…"}}'`.
   Nothing is probed and nothing is signed at this point; the connection is `pending` with `settings.verified=false`,
   and the response carries `identity` (issuer, subject, audience, steps). "Test connection" is not available for
   keyless connections for the same reason.
2. **Configure the trust** in the cloud for that subject. Manage → **Identity · keyless** (or
   `matelot connection identity --id <connection>`) shows the concrete values:
   - **GCP**: workload identity pool + OIDC provider with the issuer URL, mapping `google.subject=assertion.sub`; then
     `gcloud iam service-accounts add-iam-policy-binding SA --role=roles/iam.workloadIdentityUser --member="principal://iam.googleapis.com/<pool>/subject/integration:<id>"`
     (the principal is filled in from the connection's provider path); the service account needs Artifact Registry Reader.
   - **AWS**: IAM OIDC identity provider (issuer URL, audience `sts.amazonaws.com`); the role's trust policy is shown as
     JSON with `StringEquals { "<issuer host>:aud": "sts.amazonaws.com", "<issuer host>:sub": "integration:<id>" }`;
     attach `AmazonEC2ContainerRegistryReadOnly`.
   - **Azure**: a federated credential on the app registration — issuer, subject `integration:<id>` (exact match),
     audience `api://AzureADTokenExchange`; the `az ad app federated-credential create` command is shown ready to paste.
     Give the app `AcrPull` on the registry.
3. **Verify**: the Verify button (Identity tab, the wizard's last step, or Manage → Actions), or
   `matelot connection verify --id <connection>`. It signs a token for the real subject and runs the exchange.
   A refusal is stored as the connection's last error and shown under Identity; success sets `verified` and starts the
   first sync. Until then syncs of the connection are a quiet no-op (no error state).

The cell never signs a token for a placeholder subject: a keyless exchange without a real connection id is refused
before any cloud call.

## Disconnect and delete
- `matelot connection disconnect --id X` (`POST /integrations/:id/disconnect`) keeps the connection and its repositories
  but forgets the credentials. A disconnected keyless connection shows only "Disconnected — create the connection again"
  with its non-secret parameters (client id, role ARN, provider / service account); it cannot be verified.
- `matelot connection delete --id X` (`DELETE /integrations/:id`) removes the connection, its repositories and their
  service links. If container images pull through it, the API answers 409 listing them; `--force` (web: "Detach images
  and delete") detaches them, and their next sync looks for another usable connection to the same registry.
- Status: a verified keyless connection becomes `connected` (pending reason cleared) after its first successful sync,
  source or image. Disconnected and unverified keyless connections are never picked for image pulls.

The issuer must be reachable by the cloud provider. With `API_PUBLIC_URL` unset or not HTTPS,
the Identity page shows a warning and verification will fail at the cloud's token exchange.
