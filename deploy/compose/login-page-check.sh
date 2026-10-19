#!/usr/bin/env bash
# The realm's sign-in page as a browser gets it, through whatever fronts Keycloak: our title ("<tenant> · Matelot", set
# server-side by the matelot theme's messages), the theme selected (loginTheme=matelot applied by realm-sync), and
# every theme asset served (favicon.svg / .ico / -32.png, apple-touch-icon, logo, matelot.css, cell.css, matelot.js).
#   login-page-check.sh <cell base URL, e.g. http://localhost> [realm] [client id]
# The redirect_uri must be one the client registers (compose: "<base>/*" without an explicit :80 — "http://localhost:80/"
# is NOT "http://localhost/*" and Keycloak answers 400); redirects are followed (a canonical-hostname redirect is
# legitimate) and, when an assertion fails, the final URL, the HTTP status and the start of the body are printed — an
# empty title means something other than the sign-in page answered (a redirect, the web app, an error page).
set -euo pipefail
BASE="${1:?base URL}"; REALM="${2:-platform}"; CLIENT="${3:-platform-web}"
# strip a default port: the registered redirect URI has none
BASE="${BASE%/}"; case "$BASE" in http://*:80) BASE="${BASE%:80}";; https://*:443) BASE="${BASE%:443}";; esac
redirect="$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$BASE/")"
# the client requires PKCE (pkce.code.challenge.method=S256 in the realm): without a challenge Keycloak does not render
# the page but bounces to redirect_uri with error=invalid_request — the web app's page, "stock title" symptoms
challenge="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
url="$BASE/auth/realms/$REALM/protocol/openid-connect/auth?client_id=$CLIENT&response_type=code&scope=openid&redirect_uri=$redirect&code_challenge=$challenge&code_challenge_method=S256"
body="$(mktemp)"; trap 'rm -f "$body"' EXIT
meta="$(curl -sSL -o "$body" -w '%{http_code} %{url_effective}' "$url" 2>&1)" || { echo "the sign-in page did not load: $meta" >&2; exit 1; }
status="${meta%% *}"; final="${meta#* }"
fail() { # <message>
  echo "$1" >&2
  echo "   requested: $url" >&2
  echo "   final URL: $final (HTTP $status, $(wc -c < "$body") bytes)" >&2
  echo "   body:      $(head -c 300 "$body" | tr '\n' ' ')" >&2
  exit 1
}
[ "$status" = 200 ] || fail "the sign-in page answered HTTP $status (a 400 here usually means redirect_uri is not registered for $CLIENT)"
title="$(grep -o '<title>[^<]*</title>' "$body" | head -1 | sed 's/<[^>]*>//g')"
[ -n "$title" ] || fail "the answer has no <title>: this is not Keycloak's sign-in page"
case "$final" in *"/protocol/openid-connect/auth"*) ;; *) fail "the request ended at $final, not on the sign-in page (Keycloak bounced the request: see its log for the LOGIN_ERROR reason)";; esac
case "$title" in *"· Matelot") ;; *) fail "the sign-in page title is '$title', expected '<tenant> · Matelot' (theme messages not applied: loginTheme not set, or the theme files not mounted)";; esac
grep -q 'login/matelot/' "$body" || fail "the sign-in page does not use the matelot theme (loginTheme not applied?): $(grep -o 'resources/[^"]*' "$body" | head -2 | tr '\n' ' ')"
theme_root="$(grep -o "[^\"']*/login/matelot/img/favicon.ico" "$body" | head -1)"; theme_root="${theme_root%/img/favicon.ico}"
[ -n "$theme_root" ] || fail "the sign-in page does not link the theme's favicon.ico"
grep -q "$theme_root/css/matelot.css" "$body" || fail "matelot.css is not linked from the sign-in page"
# the theme's assets, by the path the page links (the resources prefix is Keycloak's theme version)
for asset in img/favicon.svg img/favicon.ico img/favicon-32.png img/apple-touch-icon.png img/logo.png css/matelot.css css/cell.css js/matelot.js; do   # logo.png is a CSS background, not linked
  code="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE$theme_root/$asset")"
  [ "$code" = 200 ] || { echo "theme asset $BASE$theme_root/$asset → HTTP $code" >&2; exit 1; }
done
echo "   title: $title · theme at $theme_root · favicon.svg, favicon.ico, favicon-32.png, apple-touch-icon.png, logo.png, matelot.css, cell.css, matelot.js: 200"
