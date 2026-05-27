#!/usr/bin/env bash
# Push production Workers secrets to Cloudflare via `wrangler secret put`.
#
# Reads names + values from `.secrets.env` (gitignored). This is SEPARATE from
# `.dev.vars`: `.dev.vars` holds throwaway literals for `wrangler dev` (e.g.
# AUTH_PASSWORD=local-dev-only), while `.secrets.env` holds the real production
# values — typically 1Password references so no plaintext secret lives on disk.
#
# Each value is piped over stdin, so it never appears in argv, the process
# environment, the terminal scrollback, or any AI transcript that reads this
# session. Resolved values stay in local shell vars and are seen only by wrangler.
#
# Run from project root:    bash scripts/push-secrets.sh   (or: npm run secrets:push)
#
# Re-run any time .secrets.env changes — overwrites the deployed secret. Use
# `npx wrangler secret list` to verify what's currently set.

set -euo pipefail

SECRETS_FILE=".secrets.env"
if [[ ! -f "$SECRETS_FILE" ]]; then
  echo "error: $SECRETS_FILE not found. Copy .secrets.env.example to .secrets.env and fill it in. Run from project root." >&2
  exit 1
fi

# Reject weak secrets before they ever reach Cloudflare. AUTH_PASSWORD gates the
# whole MCP and UPLOAD_TOKEN doubles as the HMAC key for signed upload links, so
# both should be long, high-entropy strings (recommend 32+ random chars, e.g.
# `openssl rand -base64 32`). 16 is the floor; the check runs on the *resolved*
# value so 1Password references are validated too. This only blocks new pushes —
# it never touches an already-deployed secret.
MIN_SECRET_LEN=16

# Keep in sync with .secrets.env.example. Order doesn't matter; we look each up.
# AUTH_PASSWORD is required; UPLOAD_TOKEN is optional (blank/unset = upload disabled).
SECRETS=(AUTH_PASSWORD UPLOAD_TOKEN)

# OP_ACCOUNT disambiguates which 1Password account owns the referenced vault when
# more than one is configured. It can come from the environment OR from an
# `OP_ACCOUNT=...` line in .secrets.env (so you don't have to remember the inline
# form). The environment wins if both are set. It is NOT a secret and is never pushed.
if [[ -z "${OP_ACCOUNT:-}" ]]; then
  acct_line=$(grep -E "^OP_ACCOUNT=" "$SECRETS_FILE" | head -1 || true)
  OP_ACCOUNT=${acct_line#OP_ACCOUNT=}
  OP_ACCOUNT=${OP_ACCOUNT%$'\r'}
  if [[ ( "$OP_ACCOUNT" == \"*\" || "$OP_ACCOUNT" == \'*\' ) && ${#OP_ACCOUNT} -ge 2 ]]; then
    OP_ACCOUNT=${OP_ACCOUNT#?}
    OP_ACCOUNT=${OP_ACCOUNT%?}
  fi
fi

pushed=0
skipped=0
for name in "${SECRETS[@]}"; do
  # Extract the value after the first `=` on the first matching uncommented line.
  # `#NAME=...` lines are skipped by the `^${name}=` anchor. Tolerates CRLF.
  line=$(grep -E "^${name}=" "$SECRETS_FILE" | head -1 || true)
  value=${line#${name}=}
  value=${value%$'\r'}

  # Strip one pair of surrounding quotes, matching how wrangler parses dotenv
  # files. 1Password's "Copy Secret Reference" includes double quotes, so this
  # lets you paste it in verbatim; single quotes work too.
  if [[ ( "$value" == \"*\" || "$value" == \'*\' ) && ${#value} -ge 2 ]]; then
    value=${value#?}
    value=${value%?}
  fi

  # Resolve 1Password secret references (op://vault/item/field) via the `op`
  # CLI. Plain literal values pass through unchanged, so .secrets.env can mix
  # references and literals freely. `op read` needs an authenticated session
  # (`op signin`) or OP_SERVICE_ACCOUNT_TOKEN; the resolved value stays in a
  # local shell var and is piped over stdin like any other secret.
  if [[ "$value" == op://* ]]; then
    if ! command -v op >/dev/null 2>&1; then
      printf 'error: %s is a 1Password reference but the `op` CLI is not installed\n' "$name" >&2
      exit 1
    fi
    # With more than one 1Password account, `op` can't tell which one owns the
    # referenced vault. Set OP_ACCOUNT (e.g. my.1password.com) to disambiguate.
    op_args=(read)
    [[ -n "${OP_ACCOUNT:-}" ]] && op_args+=(--account "$OP_ACCOUNT")
    op_args+=("$value")
    if ! value=$(op "${op_args[@]}" 2>/dev/null); then
      printf 'error: failed to resolve %s from 1Password (signed in? run `op signin`; multiple accounts? set OP_ACCOUNT=<your.1password.com>)\n' "$name" >&2
      exit 1
    fi
  fi

  if [[ -z "$value" ]]; then
    printf 'skip: %s not set in %s\n' "$name" "$SECRETS_FILE" >&2
    skipped=$((skipped + 1))
    continue
  fi

  if (( ${#value} < MIN_SECRET_LEN )); then
    printf 'error: %s resolved to %d chars; minimum is %d. Use a longer, high-entropy value (e.g. `openssl rand -base64 32`).\n' \
      "$name" "${#value}" "$MIN_SECRET_LEN" >&2
    exit 1
  fi

  printf 'pushing %s… ' "$name"
  # printf -- not echo -- avoids interpreting a leading dash in the value.
  # No trailing newline; wrangler treats the whole stdin payload as the secret.
  if printf '%s' "$value" | npx wrangler secret put "$name" >/dev/null 2>&1; then
    printf 'ok\n'
    pushed=$((pushed + 1))
  else
    printf 'FAILED\n'
    printf 'rerun with stderr visible to debug:  printf "%%s" "$VAL" | npx wrangler secret put %s\n' "$name" >&2
    exit 1
  fi
done

printf '\ndone — %d pushed, %d skipped.\n' "$pushed" "$skipped"
printf 'verify with:  npx wrangler secret list\n'
