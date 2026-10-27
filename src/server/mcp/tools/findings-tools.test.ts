import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFindingTool,
  getFindingTool,
  listFindingsTool,
  moveFindingStageTool,
  updateFindingTool,
} from "./findings-tools";
import { makeToolContext } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  listFindings: vi.fn(),
  getFinding: vi.fn(),
  createFinding: vi.fn(),
  updateFinding: vi.fn(),
  moveStage: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock("@/server/features/findings/services/FindingsService", () => ({
  FindingsService: mocks,
}));

beforeEach(() => {
  // The project belongs to some other organization.
  mocks.getProjectForOrganization.mockResolvedValue(null);
});

const ctx = () => makeToolContext({ organizationId: "org_other" });

// A project outside the caller's organization must be rejected before any
// finding is read or written.
describe("findings tools tenant scoping", () => {
  const calls = [
    [
      "list_findings",
      () => listFindingsTool.handler({ projectId: "p" }, ctx()),
    ],
    [
      "get_finding",
      () => getFindingTool.handler({ projectId: "p", id: "PM-F001" }, ctx()),
    ],
    [
      "create_finding",
      () =>
        createFindingTool.handler(
          { projectId: "p", prefix: "PM", finding: "x" },
          ctx(),
        ),
    ],
    [
      "update_finding",
      () =>
        updateFindingTool.handler(
          { projectId: "p", id: "PM-F001", finding: "x" },
          ctx(),
        ),
    ],
    [
      "move_finding_stage",
      () =>
        moveFindingStageTool.handler(
          { projectId: "p", id: "PM-F001", toStage: "brief" },
          ctx(),
        ),
    ],
  ] as const;

  it.each(calls)(
    "%s rejects a project the org does not own",
    async (_name, call) => {
      await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(mocks.getProjectForOrganization).toHaveBeenCalledWith(
        "org_other",
        "p",
      );
      for (const fn of [
        mocks.listFindings,
        mocks.getFinding,
        mocks.createFinding,
        mocks.updateFinding,
        mocks.moveStage,
      ]) {
        expect(fn).not.toHaveBeenCalled();
      }
    },
  );
});
