import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regression tests for the conflict-reporting path of
 * .github/workflows/upstream-sync.yml.
 *
 * The workflow defines bash helpers (note, report_conflicts, ...) inside the
 * sync job's `run:` script. merge_ref() calls report_conflicts() from inside
 * an `if` block, and GitHub Actions runs bash with `-eo pipefail` — but bash
 * disables errexit for every command inside a conditional, so a failed
 * `gh pr create` / `gh issue create` used to fall through to the "Opened a
 * draft pull request..." success note instead of reporting the failure.
 * These tests extract the real functions from the workflow and execute them
 * under those exact conditions (errexit suppressed by a conditional call)
 * with a stubbed `gh`, asserting that failures are reported as failures.
 */

const WORKFLOW_PATH = fileURLToPath(
  new URL("../.github/workflows/upstream-sync.yml", import.meta.url),
);

/** Extract a `name() { ... }` definition from the workflow's run script. */
function extractBashFunction(source: string, name: string): string {
  const header = new RegExp(`^\\s*${name}\\(\\) \\{$`, "m");
  const match = header.exec(source);
  if (!match) {
    throw new Error(`Could not find ${name}() in upstream-sync.yml`);
  }
  const bodyStart = source.indexOf("{", match.index);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    const char = source[i];
    if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        const end = source.indexOf("\n", i);
        return source.slice(match.index, end === -1 ? source.length : end);
      }
    }
  }
  throw new Error(`Unbalanced braces while extracting ${name}()`);
}

/** Mirror of report_conflicts() before the guards were added (#14). */
const LEGACY_REPORT_CONFLICTS = `
legacy_report_conflicts() {
  local what="$1"
  local num existing
  if [[ "$issues_enabled" == "true" ]]; then
    num=$(gh issue list \\
      --repo "$GITHUB_REPOSITORY" \\
      --state open \\
      --label "$LABEL" \\
      --limit 1 \\
      --json number \\
      --jq '.[0].number // empty')
    if [[ -n "$num" ]]; then
      gh issue edit "$num" --repo "$GITHUB_REPOSITORY" \\
        --title "Upstream sync has merge conflicts" \\
        --body-file "$body_file" >/dev/null
      note "Updated issue #\${num}. Conflicting files were not merged."
    else
      gh issue create --repo "$GITHUB_REPOSITORY" \\
        --title "Upstream sync has merge conflicts" \\
        --label "$LABEL" \\
        --body-file "$body_file"
      note "Opened a conflict issue. Nothing was merged."
    fi
    exit 1
  fi

  existing=$(find_sync_pr)
  if [[ -n "$existing" ]]; then
    note "Updated pull request #\${existing} with the conflicting files. The failed merge was not pushed."
  else
    gh pr create --repo "$GITHUB_REPOSITORY" \\
      --base main \\
      --head "$SYNC_BRANCH" \\
      --draft \\
      --label "$LABEL" \\
      --title "Upstream sync has merge conflicts" \\
      --body-file "$body_file"
    note "Opened a draft pull request listing the conflicting files. The failed merge was not pushed."
  fi
  exit 1
}
`;

interface HarnessResult {
  status: number | null;
  summary: string;
}

/**
 * Run report_conflicts (or the legacy mirror) under production conditions:
 * `set -eo pipefail`, and the call made from inside an `if` block so errexit
 * is disabled for the whole function body, exactly as merge_ref() calls it.
 */
function runHarness(options: {
  noteFn: string;
  reportFn: string;
  entryName: string;
  issuesEnabled: string;
  ghStubMode: "fail" | "ok";
}): HarnessResult {
  const dir = mkdtempSync(join(tmpdir(), "upstream-sync-harness-"));
  try {
    const noteFile = join(dir, "note.sh");
    const reportFile = join(dir, "report.sh");
    const harnessFile = join(dir, "harness.sh");
    const summaryFile = join(dir, "step-summary.txt");
    writeFileSync(noteFile, options.noteFn);
    writeFileSync(reportFile, options.reportFn);
    writeFileSync(
      harnessFile,
      `#!/usr/bin/env bash
# Production shape: Actions runs bash with -eo pipefail, and report_conflicts
# is called from inside merge_ref()'s if block, where errexit is off.
set -eo pipefail

summary="$1"
: > "$summary"
export GITHUB_STEP_SUMMARY="$summary"

GITHUB_REPOSITORY="fork-owner/open-seo"
UPSTREAM_REPO="upstream-owner/open-seo"
LABEL="upstream-sync-conflict"
SYNC_BRANCH="upstream-sync"
MARKER_MSG="chore: upstream sync marker"
issues_enabled="${options.issuesEnabled}"
remote_sync_sha="0123456789abcdef"
upstream_sha="fedcba9876543210"
fork_main="0011223344556677"
body_file="$(mktemp)"

git() { return 0; }
ensure_label() { return 0; }
write_conflict_body() { printf 'conflict body\\n' > "$body_file"; }
find_sync_pr() { :; }
gh() {
  if [[ "\${GH_STUB_MODE}" == "ok" ]]; then
    return 0
  fi
  echo "gh: simulated API failure" >&2
  return 1
}

source "${noteFile}"
source "${reportFile}"

if ${options.entryName} "upstream main"; then
  printf 'report function returned success\\n' >> "$summary"
fi
`,
    );
    const result = spawnSync("bash", [harnessFile, summaryFile], {
      encoding: "utf8",
      env: { ...process.env, GH_STUB_MODE: options.ghStubMode },
    });
    return {
      status: result.status,
      summary: readFileSync(summaryFile, "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const workflowSource = readFileSync(WORKFLOW_PATH, "utf8");
const noteFn = extractBashFunction(workflowSource, "note");
const reportConflictsFn = extractBashFunction(
  workflowSource,
  "report_conflicts",
);

describe("upstream-sync.yml report_conflicts", () => {
  it("guards gh pr create so a failed create is not logged as success", () => {
    const result = runHarness({
      noteFn,
      reportFn: reportConflictsFn,
      entryName: "report_conflicts",
      issuesEnabled: "false",
      ghStubMode: "fail",
    });
    expect(result.status).toBe(1);
    expect(result.summary).toContain(
      "Could not open a pull request listing the conflicting files.",
    );
    expect(result.summary).not.toContain("Opened a draft pull request");
  });

  it("guards gh issue create so a failed create is not logged as success", () => {
    const result = runHarness({
      noteFn,
      reportFn: reportConflictsFn,
      entryName: "report_conflicts",
      issuesEnabled: "true",
      ghStubMode: "fail",
    });
    expect(result.status).toBe(1);
    expect(result.summary).toContain(
      "Could not open a conflict issue. Nothing was merged.",
    );
    expect(result.summary).not.toContain("Opened a conflict issue.");
  });

  it("keeps the success notes on the pr create path", () => {
    const result = runHarness({
      noteFn,
      reportFn: reportConflictsFn,
      entryName: "report_conflicts",
      issuesEnabled: "false",
      ghStubMode: "ok",
    });
    expect(result.status).toBe(0);
    expect(result.summary).toContain(
      "Opened a draft pull request listing the conflicting files.",
    );
    expect(result.summary).not.toContain("Could not open a pull request");
  });

  it("keeps the success notes on the issue create path", () => {
    const result = runHarness({
      noteFn,
      reportFn: reportConflictsFn,
      entryName: "report_conflicts",
      issuesEnabled: "true",
      ghStubMode: "ok",
    });
    expect(result.status).toBe(0);
    expect(result.summary).toContain(
      "Opened a conflict issue. Nothing was merged.",
    );
    expect(result.summary).not.toContain("Could not open a conflict issue");
  });

  it("extracts guarded invocations from the workflow source", () => {
    expect(reportConflictsFn).toMatch(/\n\s*if gh pr create /);
    expect(reportConflictsFn).toMatch(/\n\s*if gh issue create /);
  });

  it("demonstrates the pre-#14 bug: an unguarded create logs false success", () => {
    // Control: the legacy mirror produces the false "Opened..." success note
    // even though gh failed. If the guards are ever removed from the
    // workflow, the first two tests fail for the same reason.
    const failed = runHarness({
      noteFn,
      reportFn: LEGACY_REPORT_CONFLICTS,
      entryName: "legacy_report_conflicts",
      issuesEnabled: "false",
      ghStubMode: "fail",
    });
    expect(failed.status).toBe(1);
    expect(failed.summary).toContain(
      "Opened a draft pull request listing the conflicting files.",
    );

    const failedIssue = runHarness({
      noteFn,
      reportFn: LEGACY_REPORT_CONFLICTS,
      entryName: "legacy_report_conflicts",
      issuesEnabled: "true",
      ghStubMode: "fail",
    });
    expect(failedIssue.status).toBe(1);
    expect(failedIssue.summary).toContain(
      "Opened a conflict issue. Nothing was merged.",
    );
  });
});
