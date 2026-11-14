import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const pkg = JSON.parse(read("package.json"));

describe.each(["lite", "full"])("electron-builder.%s.yml", (variant) => {
  const yml = read(`electron-builder.${variant}.yml`);

  it("publishes to github with the variant channel", () => {
    expect(yml).toContain("provider: github");
    expect(yml).toContain("owner: nievesjesus");
    expect(yml).toContain("repo: distill");
    expect(yml).toContain(`channel: ${variant}`);
    expect(yml).not.toContain("publish: null");
  });

  it("builds dmg and zip for mac", () => {
    const mac = yml.split(/^mac:/m)[1].split(/^win:/m)[0];
    expect(mac).toMatch(/target: dmg/);
    expect(mac).toMatch(/target: zip/);
  });
});

describe("package.json", () => {
  it.each(["dist:lite", "dist:full"])("%s ends with --publish never", (name) => {
    expect(pkg.scripts[name].trim().endsWith("--publish never")).toBe(true);
  });

  it("has electron-updater as an exact devDependency", () => {
    expect(pkg.devDependencies["electron-updater"]).toBe("6.8.11");
    expect(pkg.dependencies?.["electron-updater"]).toBeUndefined();
  });
});

describe("release workflow", () => {
  it("never publishes from electron-builder", () => {
    const lines = read(".github/workflows/release.yml")
      .split("\n")
      .filter((l) => l.includes("electron-builder --config"));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toContain("--publish never");
  });

  const wf = () => read(".github/workflows/release.yml");

  it("builds the mac zip on both mac runners", () => {
    expect(wf().match(/target: mac dmg zip/g)).toHaveLength(2);
    expect(wf()).not.toMatch(/target: mac dmg$/m);
  });

  it("includes zip files in the arch check and the upload", () => {
    const text = wf();
    const archCheck = text.split("Fail on artifacts for another arch")[1].split("Verify lite variant")[0];
    expect(archCheck).toContain("Distill-*.zip");
    const upload = text.split("name: upload-artifact v4.6.2\n")[1].split("draft-release:")[0];
    expect(upload).toContain("release/**/Distill-*.zip");
    expect(upload).toContain("manifests/*.yml");
  });

  it("refreshes manifests only for signed Windows builds", () => {
    const text = wf();
    const step = text.split("name: Collect update manifests")[1].split("name: upload-artifact v4.6.2\n")[0];
    expect(step).toContain("update-manifests.mjs refresh");
    expect(step).toMatch(/SIGNPATH_ENABLED[^\n]*== 'true'|SIGNPATH_ENABLED[^\n]*= \"true\"|SIGNPATH_ENABLED[^\n]*= 'true'/);
    expect(text.match(/update-manifests\.mjs refresh/g)).toHaveLength(1);
  });

  it("merges all six manifests in draft-release", () => {
    const text = wf();
    const job = text.split("draft-release:")[1];
    for (const out of [
      "lite-mac",
      "full-mac",
      "lite",
      "full",
      "lite-linux",
      "full-linux",
    ]) {
      expect(job).toContain(`installers/${out}.yml`);
    }
    expect(job.match(/update-manifests\.mjs merge/g)?.length).toBeGreaterThanOrEqual(1);
    expect(job).toContain("installers/*.yml");
    expect(job).toContain("installers/**/Distill-*");
  });
});
