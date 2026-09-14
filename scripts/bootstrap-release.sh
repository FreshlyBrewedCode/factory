#!/usr/bin/env bash
set -euo pipefail

# One-time, interactive bootstrap for factory's publishing pipeline. npm
# requires a package to exist before a trusted publisher can be attached to it,
# but CI has no stored token to make that first publish — someone has to break
# the cycle by hand, once. This script does everything around that manual core
# that CAN be automated or verified, and pauses for the steps that genuinely
# cannot (npm org creation and trusted-publisher entry both require a browser).
#
# Idempotent: every step checks what already exists before acting, so a failure
# part-way through is fixed by just re-running the script.
#
# Usage:
#   scripts/bootstrap-release.sh              # all three phases, in order
#   scripts/bootstrap-release.sh github        # GitHub repo/env/protection/tag
#   scripts/bootstrap-release.sh npm           # npm package-name stub
#   scripts/bootstrap-release.sh trusted-publishers

OWNER="FreshlyBrewedCode"
REPO="factory"
NPM_ORG="frebreco"
REPO_SLUG="${OWNER}/${REPO}"
WORKFLOW_FILE="release.yml"
ENVIRONMENT="release"
FLOOR_TAG="v0.1.0"
REQUIRED_CHECK="check"
PACKAGES=("@frebreco/factory")

log()  { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$1"; }
info() { printf '    - %s\n' "$1"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$1" >&2; }
die()  { printf 'error: %s\n' "$1" >&2; exit 1; }

confirm() {
  read -r -p "    Press Enter once done (Ctrl-C to abort)... " _ || true
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not on PATH."
}

# ---------------------------------------------------------------- Phase 1

phase_github() {
  log "Phase 1 — GitHub"
  require_cmd gh
  require_cmd git

  gh auth status >/dev/null 2>&1 || die "gh is not authenticated; run 'gh auth login' first."
  ok "gh is authenticated as $(gh api user -q .login)"

  if [ "$(gh config get git_protocol 2>/dev/null || echo unknown)" = "https" ] \
    && ! gh auth status 2>&1 | grep -q "'workflow'"; then
    warn "the 'workflow' scope may be missing; pushing .github/workflows/* over"
    warn "HTTPS needs it — run 'gh auth refresh -s workflow' if the push below fails."
  fi

  if gh repo view "$REPO_SLUG" >/dev/null 2>&1; then
    ok "repository $REPO_SLUG already exists"
  else
    info "creating public repository $REPO_SLUG"
    gh repo create "$REPO_SLUG" --public --source=. --remote=origin
  fi

  git remote get-url origin >/dev/null 2>&1 || git remote add origin "git@github.com:${REPO_SLUG}.git"

  if git ls-remote --exit-code --heads origin main >/dev/null 2>&1; then
    ok "main is already pushed"
  else
    info "pushing main"
    git push origin main:main
  fi

  gh repo edit "$REPO_SLUG" --default-branch main >/dev/null
  ok "main is the default branch"

  if gh api "repos/${REPO_SLUG}/environments/${ENVIRONMENT}" >/dev/null 2>&1; then
    ok "the '${ENVIRONMENT}' environment already exists"
  else
    info "creating the '${ENVIRONMENT}' environment (no required reviewers — it exists"
    info "to narrow the OIDC subject npm trusts, not to gate every release)"
    gh api --method PUT "repos/${REPO_SLUG}/environments/${ENVIRONMENT}" >/dev/null
  fi

  info "requiring the '${REQUIRED_CHECK}' status check and squash-merge-only on main"
  gh api --method PUT "repos/${REPO_SLUG}/branches/main/protection" --input - >/dev/null <<JSON
{
  "required_status_checks": { "strict": true, "contexts": ["${REQUIRED_CHECK}"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null
}
JSON
  gh api --method PATCH "repos/${REPO_SLUG}" \
    -f allow_squash_merge=true \
    -f allow_merge_commit=false \
    -f allow_rebase_merge=false >/dev/null
  ok "branch protection applied"

  # semantic-release needs a non-pre-release branch configured, which is why
  # `.releaserc.json` names `stable`. The branch itself is never pushed to or
  # published from; it exists so the config is valid and stable releases can
  # still be cut from main on demand via workflow_dispatch.
  if git ls-remote --exit-code --heads origin stable >/dev/null 2>&1; then
    ok "the 'stable' branch already exists"
  else
    info "creating 'stable' at main (referenced by .releaserc.json, never published from)"
    git fetch origin main --quiet
    git push origin "origin/main:refs/heads/stable"
  fi

  if git ls-remote --exit-code --tags origin "$FLOOR_TAG" >/dev/null 2>&1; then
    ok "$FLOOR_TAG is already tagged"
  else
    info "tagging $FLOOR_TAG at main — establishes the 0.x floor so semantic-release"
    info "never parses history before it"
    git fetch origin main --quiet
    git tag "$FLOOR_TAG" origin/main
    git push origin "$FLOOR_TAG"
  fi
}

# ---------------------------------------------------------------- Phase 2

phase_npm() {
  log "Phase 2 — npm package stub"
  require_cmd npm

  local npm_version smallest
  npm_version=$(npm --version)
  smallest=$(printf '%s\n%s\n' "11.5.1" "$npm_version" | sort -V | head -1)
  [ "$smallest" = "11.5.1" ] || die "npm ${npm_version} is too old; trusted publishing needs npm >= 11.5.1."
  ok "npm ${npm_version} (>= 11.5.1)"

  if npm whoami >/dev/null 2>&1; then
    ok "npm logged in as $(npm whoami)"
  else
    warn "not logged in to npm."
    info "run 'npm login', then re-run this script."
    exit 1
  fi

  if ! npm org ls "$NPM_ORG" >/dev/null 2>&1; then
    die "the @${NPM_ORG} organisation doesn't exist (or you're not a member); create it at https://www.npmjs.com/org/create"
  else
    ok "the @${NPM_ORG} organisation exists"
  fi

  local stub_root
  stub_root=$(mktemp -d)

  for pkg in "${PACKAGES[@]}"; do
    if npm view "$pkg" version >/dev/null 2>&1; then
      ok "$pkg already exists on the registry"
      continue
    fi
    info "publishing a 0.0.1 stub for $pkg — enough for a trusted publisher to attach to"
    local dir="${stub_root}/${pkg//\//-}"
    mkdir -p "$dir"
    cat >"${dir}/package.json" <<JSON
{
  "name": "${pkg}",
  "version": "0.0.1",
  "description": "Placeholder that reserves this name before the first real release.",
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/${REPO_SLUG}.git" }
}
JSON
    echo "Placeholder for \`${pkg}\`. See https://github.com/${REPO_SLUG}." >"${dir}/README.md"
    (cd "$dir" && npm publish --access public)
  done

  rm -rf "$stub_root"
}

# ---------------------------------------------------------------- Phase 3

phase_trusted_publishers() {
  log "Phase 3 — npm trusted publishers"
  info "For EACH of the ${#PACKAGES[@]} packages below, open its npmjs.com settings"
  info "(Settings → Trusted Publisher → GitHub Actions) and enter these exact values:"
  echo
  printf '      %-20s %s\n' "Organization/user:" "$OWNER"
  printf '      %-20s %s\n' "Repository:" "$REPO"
  printf '      %-20s %s\n' "Workflow filename:" "$WORKFLOW_FILE"
  printf '      %-20s %s\n' "Environment name:" "$ENVIRONMENT"
  echo
  warn "npm's 2026-09-03 policy defaults new trusted-publisher configs to allow only"
  warn "'npm stage publish'. Tick the 'npm publish' allowed-action checkbox explicitly —"
  warn "npm does not validate this on save; a mistake here surfaces later as an opaque"
  warn "404 or 422 during the first real release."

  for pkg in "${PACKAGES[@]}"; do
    echo
    info "package: ${pkg}"
    info "  https://www.npmjs.com/package/${pkg}/access"
    confirm
  done

  log "Re-verifying all ${#PACKAGES[@]} package(s) resolve"
  for pkg in "${PACKAGES[@]}"; do
    if npm view "$pkg" version >/dev/null 2>&1; then
      ok "$pkg resolves on the registry"
    else
      warn "$pkg does not resolve — recheck the trusted-publisher setup above."
    fi
  done
}

# --------------------------------------------------------------------- Main

main() {
  case "${1:-all}" in
    github) phase_github ;;
    npm) phase_npm ;;
    trusted-publishers) phase_trusted_publishers ;;
    all)
      phase_github
      phase_npm
      phase_trusted_publishers
      ;;
    *) die "usage: $0 [github|npm|trusted-publishers|all]" ;;
  esac
  log "Done."
}

main "$@"
