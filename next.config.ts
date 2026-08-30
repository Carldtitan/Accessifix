import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /*
   * These packages must not be bundled.
   *
   * The Daytona SDK uploads files through `form-data`, which resolves its
   * dependencies with a dynamic `require`. Next's bundler cannot follow that,
   * so the call fails at run time with:
   *
   *   Uploading files is not supported: Module "form-data" is not available
   *   in the "node" runtime: dynamic usage of require is not supported
   *
   * Leaving them external hands them to Node's own resolver, which handles it.
   * `postgres` and `better-sqlite3` are here for the same reason: native or
   * dynamically-resolved modules that a bundler will quietly break.
   */
  serverExternalPackages: [
    "@daytonaio/sdk",
    "form-data",
    "postgres",
    "better-sqlite3",
  ],
};

export default nextConfig;
