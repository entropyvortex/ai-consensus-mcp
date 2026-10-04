// Child-environment contracts for CLI seats.

import { describe, expect, it } from "vitest";
import { buildChildEnv } from "../cli-backend/index.js";

describe("cli child environment", () => {
  it("passes proxy settings through so a CLI works behind a proxy", () => {
    // Contract: the allowlist carries HTTP(S)_PROXY and NO_PROXY in both
    // spellings; API keys stay out.
    const env = buildChildEnv({
      HTTPS_PROXY: "http://proxy:3128",
      HTTP_PROXY: "http://proxy:3128",
      NO_PROXY: "localhost,.corp",
      https_proxy: "http://proxy:3128",
      http_proxy: "http://proxy:3128",
      no_proxy: "localhost",
      XAI_API_KEY: "secret",
    });
    expect(env).toEqual({
      HTTPS_PROXY: "http://proxy:3128",
      HTTP_PROXY: "http://proxy:3128",
      NO_PROXY: "localhost,.corp",
      https_proxy: "http://proxy:3128",
      http_proxy: "http://proxy:3128",
      no_proxy: "localhost",
    });
  });
});
