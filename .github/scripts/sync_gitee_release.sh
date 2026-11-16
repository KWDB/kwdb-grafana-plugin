#!/usr/bin/env bash
# Mirrors a published GitHub release to the Gitee repository: the same tag,
# title, release notes and release assets. Invoked by
# .github/workflows/gitee-sync.yml; can also be run manually from a clone that
# has the tag:
#
#   GITEE_TOKEN=<token> .github/scripts/sync_gitee_release.sh \
#     --tag v1.4.1 --github-owner KWDB --github-repo kwdb-grafana-plugin \
#     --gitee-owner kwdb --gitee-repo kwdb-grafana-plugin
#
# GITEE_TOKEN is a Gitee personal access token (设置 -> 私人令牌) with the
# `projects` scope. It authenticates the Gitee release API and, only when the
# mirror is missing the tag, the git push that creates it.
#
# The script is idempotent: an existing Gitee release is refreshed in place,
# assets that are already attached are not uploaded again, and a tag that
# already exists on Gitee is left untouched.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  sync_gitee_release.sh --tag <tag> --github-owner <owner> --github-repo <repo> \
                        --gitee-owner <owner> --gitee-repo <repo>

Environment:
  GITEE_TOKEN          Gitee personal access token (projects scope)
  GITEE_ACCESS_TOKEN   Alternative name for the same token
  GITEE_MAX_ASSET_MB   Skip assets larger than this many MB (default: 100)

Parameters:
  --tag                Release tag to sync, e.g. v1.4.1
  --github-owner       GitHub owner, e.g. KWDB
  --github-repo        GitHub repository, e.g. kwdb-grafana-plugin
  --gitee-owner        Gitee owner, e.g. kwdb
  --gitee-repo         Gitee repository, e.g. kwdb-grafana-plugin
  --gitee-token        Gitee token, alternative to the environment variable
  -h, --help           Show this help
EOF
}

log() { echo "[gitee-sync] $*"; }
die() { echo "[gitee-sync] ERROR: $*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1"
}
require_cmd gh
require_cmd jq
require_cmd curl
require_cmd git

TAG=""
GH_OWNER=""
GH_REPO=""
GITEE_OWNER=""
GITEE_REPO=""
TOKEN_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)          TAG="${2:-}"; shift 2 ;;
    --github-owner) GH_OWNER="${2:-}"; shift 2 ;;
    --github-repo)  GH_REPO="${2:-}"; shift 2 ;;
    --gitee-owner)  GITEE_OWNER="${2:-}"; shift 2 ;;
    --gitee-repo)   GITEE_REPO="${2:-}"; shift 2 ;;
    --gitee-token)  TOKEN_ARG="${2:-}"; shift 2 ;;
    -h|--help)      usage; exit 0 ;;
    *)              die "unknown argument: $1" ;;
  esac
done

if [[ -z "$TAG" || -z "$GH_OWNER" || -z "$GH_REPO" || -z "$GITEE_OWNER" || -z "$GITEE_REPO" ]]; then
  usage >&2
  exit 1
fi

TOKEN="${TOKEN_ARG:-${GITEE_TOKEN:-${GITEE_ACCESS_TOKEN:-}}}"
[[ -n "$TOKEN" ]] || die "a Gitee token is required (--gitee-token or GITEE_TOKEN/GITEE_ACCESS_TOKEN)"

MAX_ASSET_MB="${GITEE_MAX_ASSET_MB:-100}"

API="https://gitee.com/api/v5"
GITEE_HTTPS="https://gitee.com/${GITEE_OWNER}/${GITEE_REPO}.git"
TOKEN_Q="access_token=$(printf '%s' "$TOKEN" | jq -sRr @uri)"

HTTP_CODE=""
HTTP_BODY=""

# Runs curl, capturing the body in HTTP_BODY and the status in HTTP_CODE.
http() {
  local out
  out="$(curl -sS -w $'\n%{http_code}' "$@")"
  HTTP_BODY="${out%$'\n'*}"
  HTTP_CODE="${out##*$'\n'}"
}

ok() { [[ "$HTTP_CODE" == 2* ]]; }

# --- GitHub release ---------------------------------------------------------

release_json="$(gh release view "$TAG" -R "${GH_OWNER}/${GH_REPO}" \
  --json tagName,name,body,targetCommitish,isPrerelease)" \
  || die "cannot read release ${TAG} from ${GH_OWNER}/${GH_REPO}"

tag_name="$(jq -r '.tagName' <<<"$release_json")"
name="$(jq -r '.name // empty' <<<"$release_json")"
body="$(jq -r '.body // empty' <<<"$release_json")"
target="$(jq -r '.targetCommitish // empty' <<<"$release_json")"
prerelease="$(jq -r '.isPrerelease' <<<"$release_json")"
[[ -n "$tag_name" ]] || die "release ${TAG} not found on GitHub"

# --- Tag --------------------------------------------------------------------

# Ref SHA of the tag on Gitee; empty when the mirror does not have it.
# A non-zero git exit means auth or network trouble, which must not be read
# as "tag missing" (that would trigger a doomed push).
gitee_tag_ref() {
  local out
  if ! out="$(GIT_TERMINAL_PROMPT=0 git ls-remote "$GITEE_HTTPS" "refs/tags/${TAG}" 2>&1)"; then
    die "git ls-remote against Gitee failed (check GITEE_TOKEN and network): ${out}"
  fi
  printf '%s' "$out" | awk '{ print $1 }' | head -n1
}

gitee_tag_ref="$(gitee_tag_ref)"
local_tag_ref="$(git rev-parse --verify --quiet "refs/tags/${TAG}" 2>/dev/null || true)"

if [[ -n "$gitee_tag_ref" ]]; then
  if [[ -n "$local_tag_ref" && "$local_tag_ref" != "$gitee_tag_ref" ]]; then
    die "tag ${TAG} on Gitee points at ${gitee_tag_ref} but the local tag is ${local_tag_ref}; refusing to attach a release to a divergent tag"
  fi
  log "tag ${TAG} already exists on Gitee (${gitee_tag_ref})"
else
  log "tag ${TAG} is missing on Gitee; pushing it"
  # A shallow checkout (fetch-depth: 1) cannot push the tag's history, and the
  # release event checkout does not fetch tags into refs/tags by default.
  git fetch --unshallow --quiet origin >/dev/null 2>&1 || git fetch --quiet --tags origin
  if [[ -z "$local_tag_ref" ]]; then
    git fetch --quiet origin "refs/tags/${TAG}:refs/tags/${TAG}"
    local_tag_ref="$(git rev-parse --verify --quiet "refs/tags/${TAG}" 2>/dev/null || true)"
  fi
  [[ -n "$local_tag_ref" ]] || die "tag ${TAG} not found in this clone; run from a checkout that has the tag"
  git push --quiet "https://oauth2:${TOKEN}@gitee.com/${GITEE_OWNER}/${GITEE_REPO}.git" \
    "refs/tags/${TAG}" || die "failed to push tag ${TAG} to Gitee"
  gitee_tag_ref="$(gitee_tag_ref)"
  [[ -n "$gitee_tag_ref" ]] || die "pushed ${TAG} but it is still not visible on Gitee"
  log "tag ${TAG} pushed to Gitee (${gitee_tag_ref})"
fi

# --- Release ----------------------------------------------------------------

# Gitee answers 200 with a null body when the tag has no release yet.
release_id_by_tag() {
  http "${API}/repos/${GITEE_OWNER}/${GITEE_REPO}/releases/tags/${TAG}?${TOKEN_Q}"
  ok || return 0
  jq -r '.id // empty' <<<"$HTTP_BODY" 2>/dev/null || true
}

create_release() {
  # Extra curl arguments (e.g. --data-urlencode target_commitish=...) are
  # forwarded by the caller.
  http -X POST "${API}/repos/${GITEE_OWNER}/${GITEE_REPO}/releases?${TOKEN_Q}" \
    -H "Accept: application/json" \
    --data-urlencode "tag_name=${TAG}" \
    --data-urlencode "name=${name}" \
    --data-urlencode "body=${body}" \
    --data-urlencode "prerelease=${prerelease}" \
    "$@"
}

release_id="$(release_id_by_tag)"
if [[ -n "$release_id" ]]; then
  log "release ${TAG} already exists on Gitee (id ${release_id}); refreshing name and notes"
  http -X PATCH "${API}/repos/${GITEE_OWNER}/${GITEE_REPO}/releases/${release_id}?${TOKEN_Q}" \
    -H "Accept: application/json" \
    --data-urlencode "name=${name}" \
    --data-urlencode "body=${body}" \
    --data-urlencode "prerelease=${prerelease}"
  ok || die "failed to refresh the Gitee release: HTTP ${HTTP_CODE} ${HTTP_BODY}"
else
  log "creating release ${TAG} on Gitee"
  if [[ "$target" =~ ^[0-9a-f]{40}$ ]]; then
    create_release --data-urlencode "target_commitish=${target}"
  else
    create_release
  fi
  if ! ok; then
    # Gitee refuses to create a release for a tag it already knows when
    # target_commitish is passed, so retry without it and look the release up
    # again before giving up.
    log "create attempt failed (HTTP ${HTTP_CODE}: ${HTTP_BODY}); retrying without target_commitish"
    create_release
    if ! ok; then
      release_id="$(release_id_by_tag)"
      [[ -n "$release_id" ]] || die "failed to create the Gitee release: HTTP ${HTTP_CODE} ${HTTP_BODY}"
      log "release ${TAG} already existed on Gitee (id ${release_id})"
    fi
  fi
  [[ -n "$release_id" ]] || release_id="$(jq -r '.id // empty' <<<"$HTTP_BODY" 2>/dev/null || true)"
fi
[[ -n "$release_id" ]] || die "Gitee did not return a release id for ${TAG}"

# --- Assets -----------------------------------------------------------------

attached_names() {
  http "${API}/repos/${GITEE_OWNER}/${GITEE_REPO}/releases/${release_id}/attach_files?${TOKEN_Q}"
  ok || return 0
  jq -r '(if type == "array" then . else (.attach_files // .data // []) end) | .[] | .name // empty' \
    <<<"$HTTP_BODY" 2>/dev/null || true
}

attached="$(attached_names)"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

log "downloading assets from the GitHub release ${GH_OWNER}/${GH_REPO}"
gh release download "$TAG" -R "${GH_OWNER}/${GH_REPO}" -D "$tmp_dir" --pattern "*" --clobber

uploaded=0
skipped=0
shopt -s nullglob
for file in "$tmp_dir"/*; do
  [[ -f "$file" ]] || continue
  filename="$(basename "$file")"
  bytes="$(stat -c%s "$file" 2>/dev/null || stat -f%z "$file")"
  size_mb=$(( (bytes + 1048575) / 1048576 ))
  # Gitee caps release attachments at 100 MB per file (200 MB for GVP
  # projects). Skipping keeps the metadata and checksums mirrored instead of
  # failing the whole sync over one oversized archive.
  if (( size_mb > MAX_ASSET_MB )); then
    echo "[gitee-sync] WARNING: ${filename} is ${size_mb} MB, above the ${MAX_ASSET_MB} MB Gitee limit; not mirrored" >&2
    continue
  fi
  if grep -qxF "$filename" <<<"$attached"; then
    log "${filename}: already attached, skipping"
    skipped=$(( skipped + 1 ))
    continue
  fi
  http -X POST "${API}/repos/${GITEE_OWNER}/${GITEE_REPO}/releases/${release_id}/attach_files?${TOKEN_Q}" \
    -F "file=@${file}"
  ok || die "failed to upload ${filename}: HTTP ${HTTP_CODE} ${HTTP_BODY}"
  log "${filename}: uploaded"
  uploaded=$(( uploaded + 1 ))
done

log "synced ${TAG}: ${uploaded} uploaded, ${skipped} already attached"
log "https://gitee.com/${GITEE_OWNER}/${GITEE_REPO}/releases"
