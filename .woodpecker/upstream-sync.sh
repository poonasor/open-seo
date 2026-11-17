#!/usr/bin/env bash
# Upstream sync for the poonasor/open-seo fork, run by Woodpecker
# (.woodpecker/upstream-sync.yaml, cron `upstream-sync`). Ported from
# .github/workflows/upstream-sync.yml when the jog workflows were disabled:
# this fork has no GitHub Actions runner, so its scheduled runs queued and
# were cancelled instead of syncing.
#
# Merges every-app/open-seo main into this fork and opens or updates one pull
# request from sync/upstream into main. A clean merge may update sync/upstream
# with --force-with-lease so the pull request stays a merge of current main.
# main is never pushed. A conflict aborts before any push and is reported on
# the sync pull request (this fork has issues disabled).
#
# Environment:
#   GITHUB_TOKEN   Woodpecker repo secret: contents:write,
#                  pull-requests:write and issues:write on poonasor/open-seo.
#                  The gh CLI reads it as GH_TOKEN.
#   CI_REPO        Set by Woodpecker (owner/name). REPO overrides both.
#   UPSTREAM_REPO  Defaults to every-app/open-seo.
#   DRY_RUN=1      Fetch and decide only: predict the outcome with
#                  git merge-tree and push or write nothing. For local checks.
set -euo pipefail

REPO="${REPO:-${CI_REPO:-poonasor/open-seo}}"
UPSTREAM_REPO="${UPSTREAM_REPO:-every-app/open-seo}"
SYNC_BRANCH="sync/upstream"

if [[ "$SYNC_BRANCH" == "main" || "$SYNC_BRANCH" == "master" ]]; then
  echo "Refusing to use ${SYNC_BRANCH} as the sync branch." >&2
  exit 1
fi

GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
if [[ -z "$GH_TOKEN" ]]; then
  echo "GITHUB_TOKEN (the Woodpecker repo secret) is required." >&2
  exit 1
fi
export GH_TOKEN

MERGE_MSG="Merge upstream ${UPSTREAM_REPO} main into ${SYNC_BRANCH}"
MAIN_MERGE_MSG="Merge fork main into ${SYNC_BRANCH}"
MARKER_MSG="Record upstream sync conflicts"
LABEL="upstream-conflict"
export GIT_MERGE_AUTOEDIT=no

git config user.name "woodpecker-sync[bot]"
git config user.email "woodpecker-sync[bot]@users.noreply.github.com"
export GIT_AUTHOR_NAME="woodpecker-sync[bot]"
export GIT_AUTHOR_EMAIL="woodpecker-sync[bot]@users.noreply.github.com"
export GIT_COMMITTER_NAME="woodpecker-sync[bot]"
export GIT_COMMITTER_EMAIL="woodpecker-sync[bot]@users.noreply.github.com"

upstream_url="https://github.com/${UPSTREAM_REPO}.git"
if git remote get-url upstream >/dev/null 2>&1; then
  git remote set-url upstream "$upstream_url"
else
  git remote add upstream "$upstream_url"
fi

# Woodpecker's default clone can be shallow; the merge needs real parents.
if [[ "$(git rev-parse --is-shallow-repository)" == "true" ]]; then
  git fetch --unshallow origin
fi

# The default clone sends no credential header, but clear it anyway so the
# fork token is never sent with the public upstream fetch.
git -c "http.https://github.com/.extraheader=" fetch --no-tags upstream main
git fetch --no-tags origin main

remote_sync_sha=""
ls_status=0
git ls-remote --exit-code --heads origin "$SYNC_BRANCH" >/dev/null 2>&1 || ls_status=$?
if [[ "$ls_status" -eq 0 ]]; then
  git fetch --no-tags origin "+refs/heads/${SYNC_BRANCH}:refs/remotes/origin/${SYNC_BRANCH}"
  remote_sync_sha=$(git rev-parse "origin/${SYNC_BRANCH}")
elif [[ "$ls_status" -ne 2 ]]; then
  echo "Could not list ${SYNC_BRANCH} on origin (git ls-remote exited ${ls_status})." >&2
  exit 1
fi

fork_main=$(git rev-parse origin/main)
upstream_sha=$(git rev-parse upstream/main)
issues_enabled=$(gh api "repos/${REPO}" --jq .has_issues)
body_file=$(mktemp)

note() {
  printf '%s\n' "$1"
}

# DRY_RUN: predict the outcome without touching refs or writing to GitHub.
if [[ "${DRY_RUN:-0}" == "1" ]]; then
  if git merge-base --is-ancestor "$upstream_sha" "$fork_main"; then
    note "dry-run: upstream main ${upstream_sha} is already in fork main ${fork_main}; the run would be a no-op."
  else
    mt_status=0
    mt_output=$(git merge-tree --write-tree --name-only "$fork_main" "$upstream_sha" 2>&1) || mt_status=$?
    if [[ "$mt_status" -eq 0 ]]; then
      note "dry-run: upstream ${UPSTREAM_REPO} main ${upstream_sha} merges into fork main ${fork_main} cleanly."
      note "dry-run: would rebuild ${SYNC_BRANCH} from fork main, push it, and open or update the sync pull request."
    elif [[ "$mt_status" -eq 1 ]]; then
      note "dry-run: merging upstream ${upstream_sha} into fork main ${fork_main} conflicts. The job would exit 0 after reporting these files on the ${SYNC_BRANCH} pull request; nothing would be pushed:"
      printf '%s\n' "$mt_output" | awk 'NR > 1 && $0 == "" { exit } NR > 1 { print "  - " $0 }'
    else
      note "dry-run: git merge-tree failed with status ${mt_status}:" >&2
      printf '%s\n' "$mt_output" | sed 's/^/  /' >&2
      exit 1
    fi
  fi
  note "dry-run: stopped before any push or pull request update (issues on ${REPO} enabled: ${issues_enabled})."
  exit 0
fi

# Push credentials for the one branch this job may update. Written only after
# the dry-run exit above, so a dry run never stores a token.
printf 'machine github.com\n\tlogin x-access-token\n\tpassword %s\n' "$GH_TOKEN" > "${HOME}/.netrc"
chmod 600 "${HOME}/.netrc"

has_human_commits() {
  [[ -n "$remote_sync_sha" ]] || return 1
  local subjects subject
  # First-parent only: upstream commits brought in by our merge are not
  # edits someone pushed to the sync branch.
  subjects=$(git log --first-parent --format=%s "${fork_main}..${remote_sync_sha}")
  while IFS= read -r subject; do
    [[ -z "$subject" ]] && continue
    [[ "$subject" == "$MERGE_MSG" ]] && continue
    [[ "$subject" == "$MAIN_MERGE_MSG" ]] && continue
    [[ "$subject" == "$MARKER_MSG" ]] && continue
    return 0
  done <<< "$subjects"
  return 1
}

ensure_label() {
  gh label create "$LABEL" \
    --repo "$REPO" \
    --color d73a4a \
    --description "Upstream merge has conflicts" \
    --force >/dev/null
}

write_conflict_body() {
  local what="$1"
  local files="$2"
  local file
  {
    printf 'Merging %s into %s stopped with conflicts. The merge was aborted. main was not changed.\n\n' "$what" "$SYNC_BRANCH"
    printf -- '- Upstream: %s@%s\n' "$UPSTREAM_REPO" "$upstream_sha"
    printf -- '- Fork main: %s\n\n' "$fork_main"
    printf 'Conflicting files:\n\n'
    if [[ -z "$files" ]]; then
      printf '%s\n' "- (git reported a merge failure without listing unmerged files)"
    else
      while IFS= read -r file; do
        [[ -z "$file" ]] && continue
        printf -- '- %s\n' "$file"
      done <<< "$files"
    fi
    printf '\nThe sync branch was not updated with this failed merge. Resolve the files on %s, or wait for the next cron run. main is never pushed.\n' "$SYNC_BRANCH"
  } > "$body_file"
}

write_clean_body() {
  cat > "$body_file" <<EOF
Merges upstream \`${UPSTREAM_REPO}\` main (\`${upstream_sha}\`) into this fork's \`main\` for review.

Fork \`main\` at this run: \`${fork_main}\`.

This pull request is opened with a Woodpecker repository secret (a personal access token), so CI runs on it: Woodpecker (.woodpecker/ci.yaml) reports on this pull request like any other.

\`main\` is not force-pushed. Merge this pull request with a real merge commit — never squash — so upstream main becomes an ancestor of main.
EOF
}

find_sync_pr() {
  gh pr list \
    --repo "$REPO" \
    --base main \
    --head "$SYNC_BRANCH" \
    --state open \
    --limit 1 \
    --json number \
    --jq '.[0].number // empty'
}

push_sync() {
  local head
  head=$(git rev-parse --abbrev-ref HEAD)
  if [[ "$head" != "$SYNC_BRANCH" ]]; then
    echo "Refusing to push ${head}." >&2
    exit 1
  fi
  if [[ -z "$remote_sync_sha" ]]; then
    git push origin "HEAD:refs/heads/${SYNC_BRANCH}"
    remote_sync_sha=$(git rev-parse HEAD)
    return 0
  fi
  if git merge-base --is-ancestor "$remote_sync_sha" HEAD; then
    git push origin "HEAD:refs/heads/${SYNC_BRANCH}"
  else
    git push --force-with-lease="refs/heads/${SYNC_BRANCH}:${remote_sync_sha}" \
      origin "HEAD:refs/heads/${SYNC_BRANCH}"
  fi
  remote_sync_sha=$(git rev-parse HEAD)
}

report_conflicts() {
  local what="$1"
  local files num existing draft
  files=$(git diff --name-only --diff-filter=U | sort -u)
  git merge --abort
  ensure_label
  write_conflict_body "$what" "$files"

  if [[ "$issues_enabled" == "true" ]]; then
    num=$(gh issue list \
      --repo "$REPO" \
      --state open \
      --label "$LABEL" \
      --limit 1 \
      --json number \
      --jq '.[0].number // empty')
    if [[ -n "$num" ]]; then
      gh issue edit "$num" --repo "$REPO" \
        --title "Upstream sync has merge conflicts" \
        --body-file "$body_file" >/dev/null
      note "Updated issue #${num}. Conflicting files were not merged."
    else
      # report_conflicts can run inside a conditional, where
      # errexit is off, so check the result instead of trusting it.
      if gh issue create --repo "$REPO" \
        --title "Upstream sync has merge conflicts" \
        --label "$LABEL" \
        --body-file "$body_file"; then
        note "Opened a conflict issue. Nothing was merged."
      else
        note "Could not open a conflict issue. Nothing was merged."
        exit 1
      fi
    fi
    exit 0
  fi

  # Issues are disabled. Report on the sync pull request instead.
  # A pull request needs at least one commit main lacks. When the
  # branch is missing or has none, push an empty marker commit.
  if [[ -z "$remote_sync_sha" ]] \
    || [[ -z "$(git rev-list --max-count=1 "${fork_main}..${remote_sync_sha}")" ]]; then
    git checkout --no-track -B "$SYNC_BRANCH" origin/main
    git commit --allow-empty -m "$MARKER_MSG"
    push_sync
  fi

  existing=$(find_sync_pr)
  if [[ -n "$existing" ]]; then
    gh pr edit "$existing" --repo "$REPO" \
      --title "Upstream sync has merge conflicts" \
      --body-file "$body_file" \
      --add-label "$LABEL" >/dev/null
    draft=$(gh pr view "$existing" --repo "$REPO" --json isDraft --jq .isDraft)
    if [[ "$draft" != "true" ]]; then
      gh pr ready "$existing" --repo "$REPO" --undo >/dev/null
    fi
    note "Updated pull request #${existing} with the conflicting files. The failed merge was not pushed."
  else
    # report_conflicts can run inside a conditional, where errexit
    # is off, so check the result instead of trusting it.
    if gh pr create --repo "$REPO" \
      --base main \
      --head "$SYNC_BRANCH" \
      --draft \
      --label "$LABEL" \
      --title "Upstream sync has merge conflicts" \
      --body-file "$body_file"; then
      note "Opened a draft pull request listing the conflicting files. The failed merge was not pushed."
    else
      note "Could not open a pull request listing the conflicting files. Check that the token may create pull requests. The failed merge was not pushed."
      exit 1
    fi
  fi
  # The conflict is reported on a pull request, so the job succeeds.
  exit 0
}

# Returns 0 after creating a merge commit.
# Returns 1 when the ref is already up to date or changes no files.
# A conflict calls report_conflicts, which exits without pushing a
# resolution. Any other git failure exits non-zero.
# Callers may ignore only status 1. A conditional call turns off
# errexit for this function, so the git commands below exit themselves.
merge_ref() {
  local ref="$1"
  local what="$2"
  local message="$3"
  local status=0
  local merge_head=""
  local tree_status=0
  local index_status=0

  git merge --no-ff --no-commit "$ref" || status=$?
  if [[ "$status" -ne 0 ]]; then
    if git diff --name-only --diff-filter=U | grep -q .; then
      report_conflicts "$what"
    fi
    echo "Merging ${what} failed." >&2
    exit 1
  fi
  merge_head=$(git rev-parse --git-path MERGE_HEAD) || {
    echo "Could not resolve MERGE_HEAD while merging ${what}." >&2
    exit 1
  }
  if [[ ! -f "$merge_head" ]]; then
    return 1
  fi
  git diff --quiet || tree_status=$?
  if [[ "$tree_status" -gt 1 ]]; then
    echo "Could not compare the working tree while merging ${what}." >&2
    exit 1
  fi
  git diff --cached --quiet || index_status=$?
  if [[ "$index_status" -gt 1 ]]; then
    echo "Could not compare the index while merging ${what}." >&2
    exit 1
  fi
  if [[ "$tree_status" -eq 0 && "$index_status" -eq 0 ]]; then
    git merge --abort || {
      echo "Could not abort the empty merge of ${what}." >&2
      exit 1
    }
    return 1
  fi
  git commit -m "$message" || {
    echo "Could not commit the merge of ${what}." >&2
    exit 1
  }
  return 0
}

close_conflict_issues() {
  local num
  [[ "$issues_enabled" == "true" ]] || return 0
  num=$(gh issue list \
    --repo "$REPO" \
    --state open \
    --label "$LABEL" \
    --limit 1 \
    --json number \
    --jq '.[0].number // empty' 2>/dev/null || true)
  [[ -n "$num" ]] || return 0
  gh issue close "$num" --repo "$REPO" \
    --comment "Upstream main is in fork main, or the sync branch merged cleanly. Closing this conflict report." \
    >/dev/null
  note "Closed conflict issue #${num}."
}

close_obsolete_conflict_pr() {
  local num kind
  [[ "$issues_enabled" == "true" ]] && return 0
  [[ -n "$remote_sync_sha" ]] || return 0
  git diff --quiet "$fork_main" "$remote_sync_sha" || return 0
  num=$(find_sync_pr)
  [[ -n "$num" ]] || return 0
  kind=$(gh pr view "$num" --repo "$REPO" --json isDraft,labels \
    --jq "if .isDraft and any(.labels[]; .name == \"${LABEL}\") then \"conflict\" else \"other\" end")
  [[ "$kind" == "conflict" ]] || return 0
  gh pr close "$num" --repo "$REPO" \
    --comment "Upstream has nothing new relative to fork main. Closing this conflict report." \
    >/dev/null
  note "Closed conflict pull request #${num}."
}

finish_noop() {
  note "$1"
  close_conflict_issues
  close_obsolete_conflict_pr
  exit 0
}

publish_clean_pr() {
  local num draft
  write_clean_body
  num=$(find_sync_pr)
  if [[ -n "$num" ]]; then
    gh pr edit "$num" --repo "$REPO" \
      --title "Sync upstream ${UPSTREAM_REPO} main" \
      --body-file "$body_file" >/dev/null
    # The label is absent on a pull request that was never in conflict.
    gh pr edit "$num" --repo "$REPO" --remove-label "$LABEL" >/dev/null || true
    draft=$(gh pr view "$num" --repo "$REPO" --json isDraft --jq .isDraft)
    if [[ "$draft" == "true" ]]; then
      gh pr ready "$num" --repo "$REPO" >/dev/null
    fi
    note "Updated pull request #${num}."
  else
    gh pr create --repo "$REPO" \
      --base main \
      --head "$SYNC_BRANCH" \
      --title "Sync upstream ${UPSTREAM_REPO} main" \
      --body-file "$body_file"
    note "Opened a pull request for the upstream merge."
  fi
  close_conflict_issues
}

if git merge-base --is-ancestor "$upstream_sha" "$fork_main"; then
  finish_noop "Upstream main ${upstream_sha} is already in fork main ${fork_main}."
fi

if [[ -n "$remote_sync_sha" ]] \
  && git merge-base --is-ancestor "$upstream_sha" "$remote_sync_sha" \
  && git merge-base --is-ancestor "$fork_main" "$remote_sync_sha"; then
  if git diff --quiet "$fork_main" "$remote_sync_sha"; then
    finish_noop "sync/upstream already matches fork main. Upstream has nothing new."
  fi
  note "sync/upstream already contains fork main and upstream main."
  publish_clean_pr
  exit 0
fi

if [[ -n "$remote_sync_sha" ]] && has_human_commits; then
  note "Keeping commits already on ${SYNC_BRANCH} and merging into them."
  git checkout --no-track -B "$SYNC_BRANCH" "$remote_sync_sha"
  # Status 1 means nothing new, so the next merge still runs. A
  # conflict does not return: merge_ref reports it and exits. Any
  # other status is a git error and fails the job.
  merge_status=0
  merge_ref origin/main "fork main (${fork_main})" "$MAIN_MERGE_MSG" || merge_status=$?
  [[ "$merge_status" -le 1 ]] || exit "$merge_status"
  merge_status=0
  merge_ref upstream/main "upstream ${UPSTREAM_REPO} main (${upstream_sha})" "$MERGE_MSG" || merge_status=$?
  [[ "$merge_status" -le 1 ]] || exit "$merge_status"
  if git diff --quiet "$fork_main" HEAD; then
    finish_noop "Upstream main does not change files relative to fork main."
  fi
  if [[ "$(git rev-parse HEAD)" != "$remote_sync_sha" ]]; then
    push_sync
  fi
  publish_clean_pr
  exit 0
fi

note "Building ${SYNC_BRANCH} from fork main ${fork_main}."
git checkout --no-track -B "$SYNC_BRANCH" origin/main
if merge_ref upstream/main "upstream ${UPSTREAM_REPO} main (${upstream_sha})" "$MERGE_MSG"; then
  push_sync
  publish_clean_pr
else
  finish_noop "Upstream main does not change any files relative to fork main ${fork_main}."
fi
