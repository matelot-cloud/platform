
## Own GitHub App: flow, pitfalls, checklist

- **Slug and name** come from GitHub (`GET /app`) at connect time; the slug you type is only a hint and a mismatch is reported. The install link is always built from GitHub's slug. The Name field is a display label.
- **Retries** update the pending connection of the same App at the same level instead of creating another one.
- **Already installed?** GitHub then opens the installation settings instead of the Setup URL, so no callback arrives. Matelot lists the App's installations on connect and binds the one that fits; otherwise use *Manage → Actions → Link existing installation*. The callback also handles `setup_action=update`.
- **Expired link**: install links are signed for 15 minutes. If GitHub sends you back later, the Connections page explains and offers "Link existing installation".
- **Two URLs**: Setup URL / Redirect URI (`…/api/v1/integrations/github/callback`, browser GET) vs Webhook URL (`…/api/v1/webhooks/github/<connection id>`, GitHub servers POST). A GET on the webhook URL now returns an explanation instead of 404. Webhooks are verified with `X-Hub-Signature-256`, deduplicated on `X-GitHub-Delivery`, acknowledged with 202 and processed asynchronously.
- **localhost / private hosts**: GitHub cannot deliver webhooks there. Use a tunnel (smee.io, ngrok, Tailscale Funnel) or click Later: the connection works without webhooks, with Sync now and periodic polling.
- **Permissions**: Repository — Metadata read, Contents read, Administration read, Issues read & write; Organization — Projects read & write (boards). Granted permissions are read from the installation and missing ones are listed in Manage → Details; after adding permissions to the App, the organization must accept them (Organization → Settings → GitHub Apps), then *Check again*.
- **Capabilities by connection type**: deploy key / plain git → clone only, no issues or boards; fine-grained token → issues and user- or organization-owned boards; GitHub App → issues and organization-owned boards only (a `/users/…` board is skipped with a log message).
- **One App per environment** (dev behind a tunnel, staging, prod): an App has a single webhook URL and separate keys limit the blast radius.

### Test checklist
1. Connect with a wrong slug hint → connection created, warning shows GitHub's slug, Install link uses it.
2. Connect the same App twice at the same level → second attempt updates the first pending record (no duplicates).
3. Install the App on GitHub first, then connect → bound immediately, status pending → connected after the first sync.
4. Wait > 15 min on the GitHub install page, then continue → Connections page shows the expired-link banner; Link existing installation completes it.
5. `curl -i https://<host>/api/v1/webhooks/github/<id>` → 200 with the explanation, not 404.
6. Remove Issues write from the App → Manage → Check again lists it as missing; add it back, accept on GitHub, Check again → clean.
7. App connection + `/users/<you>/projects/1` board → issue created, log says user boards need a token connection.
