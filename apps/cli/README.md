# matelot-cli

Command-line client for [Matelot](https://matelot-cloud.github.io/website/). Install: `npm install -g github:matelot-cloud/setup-cli#v2` (Node ≥ 18, no dependencies) or the GitHub Action below; releases are tags of this repository. Authenticates with **signed CI tokens** (HMAC over
timestamp, nonce, method, path and body — the secret never travels), created in a project's
*Settings → CI tokens*.

```bash
export MATELOT_URL=https://acme.secops.example.com MATELOT_KEY_ID=sk_… MATELOT_SECRET=sec_…
npx matelot-cli whoami
npx matelot-cli deploy --env <environmentId> --version 1.2.0 --image ghcr.io/acme/app@sha256:…
npx matelot-cli pipeline --service <serviceId> --ref $GITHUB_SHA --wait
npx matelot-cli sbom --service <serviceId> --file bom.cdx.json --target image --image ghcr.io/acme/app:1.2.0
```

GitHub Actions:

```yaml
- uses: matelot-cloud/setup-cli@v2             # installs the CLI at that tag, exports MATELOT_* from inputs
  with: { url: ${{ vars.MATELOT_URL }}, key-id: ${{ secrets.MATELOT_KEY_ID }}, secret: ${{ secrets.MATELOT_SECRET }} }
- run: matelot deploy --env ${{ vars.MATELOT_ENV_PRODUCTION }} --version ${{ github.ref_name }}
```

Exit codes: 0 ok · 1 error · 3 authentication failed. `--json` prints raw responses; `pipeline --wait` exits 1 when the pipeline does not succeed (use it as a gate).
