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
});
