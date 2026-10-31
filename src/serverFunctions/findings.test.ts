import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { moveFindingStage, remeasureFinding } from "./findings";

const mocks = vi.hoisted(() => ({
  moveStage: vi.fn(),
  remeasureFinding: vi.fn(),
}));
vi.mock("@/server/features/findings/services/FindingsService", () => ({
  FindingsService: mocks,
}));
vi.mock("@/serverFunctions/middleware", () => ({ requireProjectContext: [] }));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    middleware: () => ({
      validator: (schema: z.ZodType) => ({
        handler:
          (
            handler: (input: {
              data: unknown;
              context: { projectId: string; userId: string };
            }) => unknown,
          ) =>
          ({ data }: { data: unknown }) =>
            handler({
              data: schema.parse(data),
              context: { projectId: "authorized-project", userId: "u1" },
            }),
      }),
    }),
  }),
}));

describe("finding stage actions", () => {
  beforeEach(() => {
    const detail = { finding: {}, events: [], measurements: [] };
    mocks.moveStage.mockResolvedValue(detail);
    mocks.remeasureFinding.mockResolvedValue(detail);
  });

  it("scopes a move to the authorized project and records the user as actor", async () => {
    await moveFindingStage({
      data: {
        projectId: "someone-elses",
        id: "PM-F001",
        toStage: "brief",
        note: "  ",
      },
    });
    expect(mocks.moveStage).toHaveBeenCalledWith(
      "authorized-project",
      "PM-F001",
      { toStage: "brief", note: null, actor: "user:u1" },
    );
  });

  it("re-measures within the authorized project", async () => {
    await remeasureFinding({ data: { projectId: "p", id: "PM-F001" } });
    expect(mocks.remeasureFinding).toHaveBeenCalledWith(
      "authorized-project",
      "PM-F001",
      "user:u1",
    );
  });
});
