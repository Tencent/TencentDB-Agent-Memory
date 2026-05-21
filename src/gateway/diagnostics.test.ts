import { describe, expect, test } from "vitest";

import { buildGatewayDiagnostics } from "./server.js";

describe("gateway diagnostics", () => {
  test("exposes process identity needed to verify which gateway is serving health checks", () => {
    const diagnostics = buildGatewayDiagnostics("/tmp/memory-tdai");

    expect(diagnostics.pid).toBe(process.pid);
    expect(diagnostics.cwd).toBe(process.cwd());
    expect(diagnostics.dataDir).toBe("/tmp/memory-tdai");
    expect(diagnostics.user).toBe(process.env.USER ?? process.env.USERNAME ?? "");
    expect(diagnostics.home).toBe(process.env.HOME ?? process.env.USERPROFILE ?? "");
  });
});
