import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: [
    "@deck.gl/core",
    "@deck.gl/layers",
    "apache-arrow",
    "arrow-supercluster",
  ],
});
