import path from "node:path";
import { describe, expect, test } from "vitest";
import { resolveGatewayUserScope } from "./server.js";

describe("gateway user data scope", () => {
  test("keeps anonymous requests on the legacy base data directory", () => {
    const baseDir = path.join("/tmp", "memory-tdai");

    const scope = resolveGatewayUserScope(baseDir);

    expect(scope.isolated).toBe(false);
    expect(scope.cacheKey).toBe("legacy");
    expect(scope.dataDir).toBe(baseDir);
  });

  test("routes an explicit user id into a stable isolated data directory", () => {
    const baseDir = path.join("/tmp", "memory-tdai");

    const scope = resolveGatewayUserScope(baseDir, " default ");

    expect(scope.isolated).toBe(true);
    expect(scope.cacheKey).toBe("user:default");
    expect(scope.dataDir).toMatch(/\/tmp\/memory-tdai\/users\/default-[0-9a-f]{12}$/);
  });

  test("sanitizes malicious user ids so they cannot escape the base directory", () => {
    const baseDir = path.join("/tmp", "memory-tdai");

    const scope = resolveGatewayUserScope(baseDir, "../lejun");

    expect(scope.isolated).toBe(true);
    expect(scope.dataDir.startsWith(path.join(baseDir, "users") + path.sep)).toBe(true);
    expect(scope.dataDir).not.toContain("..");
  });
});
