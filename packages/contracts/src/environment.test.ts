import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentDescriptor } from "./environment.ts";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

const descriptor = {
  environmentId: "environment-1",
  label: "Local",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.32",
  capabilities: { repositoryIdentity: true },
} as const;

describe("ExecutionEnvironmentDescriptor", () => {
  it("treats a missing pull-request capability as unsupported under version skew", () => {
    expect(decodeDescriptor(descriptor).capabilities.pullRequests).toBeUndefined();
  });

  it("treats the Source Control workspace capability as absent under version skew", () => {
    expect(decodeDescriptor(descriptor).capabilities.sourceControlWorkspace).toBeUndefined();
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, sourceControlWorkspace: true },
      }).capabilities.sourceControlWorkspace,
    ).toBe(true);
  });

  it("preserves an advertised pull-request capability", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, pullRequests: true },
      }).capabilities.pullRequests,
    ).toBe(true);
  });

  it("treats a missing attachment upload capability as unsupported", () => {
    expect(decodeDescriptor(descriptor).capabilities.attachmentUploads).toBeUndefined();
  });

  it("preserves an advertised attachment upload capability", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, attachmentUploads: true },
      }).capabilities.attachmentUploads,
    ).toBe(true);
  });

  it("preserves the server's generic attachment upload limit", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: {
          ...descriptor.capabilities,
          fileAttachments: { maxUploadBytes: 50 * 1024 * 1024 },
        },
      }).capabilities.fileAttachments,
    ).toEqual({ maxUploadBytes: 50 * 1024 * 1024 });
  });

  it("treats project terminal attachment as optional under version skew", () => {
    expect(decodeDescriptor(descriptor).capabilities.projectTerminalAttachment).toBeUndefined();
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, projectTerminalAttachment: true },
      }).capabilities.projectTerminalAttachment,
    ).toBe(true);
  });
});

it("keeps guided human workflow capability separate from managed execution under version skew", () => {
  expect(decodeDescriptor(descriptor).capabilities.projectTeamGuidedWrites).toBeUndefined();
  const current = decodeDescriptor({
    ...descriptor,
    capabilities: {
      ...descriptor.capabilities,
      projectTeamGuidedWrites: true,
      projectTeamExecution: false,
    },
  });
  expect(current.capabilities.projectTeamGuidedWrites).toBe(true);
  expect(current.capabilities.projectTeamExecution).toBe(false);
  expect(() =>
    decodeDescriptor({ ...descriptor, capabilities: { projectTeamGuidedWrites: "true" } }),
  ).toThrow();
});

it("keeps exact human memory retraction unsupported on older guided-write hosts", () => {
  const older = {
    ...descriptor,
    capabilities: { ...descriptor.capabilities, projectTeamGuidedWrites: true },
  };
  expect(decodeDescriptor(older).capabilities.projectTeamMemoryRetractions).toBeUndefined();
  expect(
    decodeDescriptor({
      ...older,
      capabilities: { ...older.capabilities, projectTeamMemoryRetractions: true },
    }).capabilities.projectTeamMemoryRetractions,
  ).toBe(true);
  expect(() =>
    decodeDescriptor({
      ...older,
      capabilities: { ...older.capabilities, projectTeamMemoryRetractions: "true" },
    }),
  ).toThrow();
});
