import { describe, expect, it } from "vitest";
import { buildHttpsRequestOptions } from "./backend-client.js";

describe("buildHttpsRequestOptions", () => {
  it("keeps TLS certificate verification enabled by default", () => {
    const options = buildHttpsRequestOptions({});

    expect(options).not.toHaveProperty("rejectUnauthorized", false);
  });

  it("only disables TLS verification when explicitly requested", () => {
    const options = buildHttpsRequestOptions({ allowInsecureTls: true });

    expect(options).toMatchObject({ rejectUnauthorized: false });
  });

  it("passes a configured CA certificate without disabling verification", () => {
    const ca = Buffer.from("-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n");

    const options = buildHttpsRequestOptions({ ca });

    expect(options).toMatchObject({ ca });
    expect(options).not.toHaveProperty("rejectUnauthorized", false);
  });
});
