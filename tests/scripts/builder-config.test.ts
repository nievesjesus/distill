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
    const upload = text.split("name: upload-artifact v4.6.2\n")[1].split("\n  release:\n")[0];
    expect(upload).toContain("release/**/Distill-*.zip");
    expect(upload).toContain("manifests/*.yml");
  });

  it("refreshes manifests only for signed Windows builds", () => {
    const text = wf();
    const step = text.split("name: Collect update manifests")[1].split("name: upload-artifact v4.6.2\n")[0];
    expect(step).toContain("update-manifests.mjs refresh");
    expect(step).toMatch(/SIGNPATH_ENABLED[^\n]*== 'true'|SIGNPATH_ENABLED[^\n]*= \"true\"|SIGNPATH_ENABLED[^\n]*= 'true'/);
    expect(text.match(/update-manifests\.mjs refresh/g)).toHaveLength(2);
  });

  it("merges all six manifests in the release job", () => {
    const text = wf();
    const job = text.split("\n  release:\n")[1];
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

describe("release automation workflows", () => {
  const tagRelease = () => read(".github/workflows/tag-release.yml");
  const release = () => read(".github/workflows/release.yml");
  const publish = () => read(".github/workflows/publish.yml");

  it("tag-release triggers on main package.json and dispatches release.yml", () => {
    const text = tagRelease();
    expect(text).toMatch(/branches: \[main\]/);
    expect(text).toMatch(/paths: \[package\.json\]/);
    expect(text).toContain("workflow_dispatch");
    expect(text).toContain("scripts/release-tag.mjs");
    expect(text).toContain('gh workflow run release.yml --ref "$TAG"');
    expect(text).toContain("github.ref == 'refs/heads/main'");
    expect(text).toContain("cancel-in-progress: false");
    expect(text).toMatch(/actions: write/);
  });

  it("release.yml verifies manifests before the release step and publishes it", () => {
    const job = release().split("\n  release:\n")[1];
    const verify = job.indexOf("update-manifests.mjs verify installers installers/*.yml");
    expect(verify).toBeGreaterThan(-1);
    expect(verify).toBeLessThan(job.indexOf("softprops/action-gh-release"));
    expect(job).toContain("--draft=false");
    expect(job).toMatch(/gh workflow run publish\.yml --ref main -f tag="\$TAG"/);
    expect(job).toContain("body_path:");
    expect(job).toContain("generate_release_notes:");
    expect(job.match(/softprops\/action-gh-release/g)).toHaveLength(1);
  });

  it("release.yml refreshes the mac dmg manifest and retries with backoff", () => {
    const text = release();
    expect(text).toMatch(/update-manifests\.mjs refresh "\$manifest" "release\/\$variant\/Distill-\$variant-mac-/);
    expect(text).toContain("attempt * 60");
    expect(text).not.toContain("-ge 3");
    expect(text).not.toContain("sleep 30");
    expect(text.match(/-ge 5/g)!.length).toBeGreaterThanOrEqual(3);
  });

  it("publish.yml accepts a dispatched tag and no longer reads the release event tag directly", () => {
    const text = publish();
    expect(text).toContain("workflow_dispatch:");
    expect(text).toMatch(/inputs:\n\s+tag:/);
    const rest = text.replace("TAG: ${{ inputs.tag || github.event.release.tag_name }}", "");
    expect(rest).not.toContain("github.event.release.tag_name");
    expect(text.match(/\^v\[0-9\]\+/g)).toHaveLength(2);
  });
});

describe("mcp registry workflow", () => {
  const wf = () => read(".github/workflows/mcp-registry.yml");
  const COSIGN = "756fe2d284c7292c4e9b62c8a28f1e5629c59532";

  it("runs hourly and on demand without overlapping runs", () => {
    const text = wf();
    expect(text).toContain("workflow_dispatch:");
    expect(text).toContain("cron: '17 * * * *'");
    expect(text).toContain("group: mcp-registry");
    expect(text).toContain("cancel-in-progress: false");
  });

  it("asks for the OIDC token and nothing else", () => {
    const text = wf();
    expect(text).toMatch(/permissions:\n\s+contents: read\n\s+id-token: write/);
    expect(text).not.toMatch(/write-all|contents: write/);
  });

  it("pins cosign and verifies the publisher before logging in", () => {
    const text = wf();
    expect(text).toContain(`sigstore/cosign-installer@${COSIGN}`);
    const verify = text.indexOf("cosign verify-blob");
    expect(verify).toBeGreaterThan(-1);
    expect(verify).toBeLessThan(text.indexOf("login github-oidc"));
    expect(text).toContain("--certificate-oidc-issuer https://token.actions.githubusercontent.com");
    expect(text).toContain("v1.8.9");
  });

  it("waits for npm and skips versions already listed before publishing", () => {
    const text = wf();
    const npmView = text.indexOf("npm view");
    const lookup = text.indexOf("registry.modelcontextprotocol.io/v0.1/servers/");
    const publish = text.indexOf("./mcp-publisher publish");
    expect(npmView).toBeGreaterThan(-1);
    expect(npmView).toBeLessThan(lookup);
    expect(lookup).toBeLessThan(publish);
    expect(text).toContain("mcpName");
    expect(text).toContain("waiting for npm");
    expect(text).toContain("already listed");
  });

  it("never interpolates expressions inside run scripts", () => {
    const interpolated = wf()
      .split(/\n\s+- name:/)
      .map((step) => (step.includes("run: |") ? step.split("run: |")[1] : ""))
      .filter((script) => script.includes("${{"));
    expect(interpolated).toEqual([]);
  });
});
