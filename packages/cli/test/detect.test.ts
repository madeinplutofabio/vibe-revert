// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectFramework } from "../src/detect.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "viberevert-detect-test-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("detectFramework — empty repo", () => {
  it("returns generic resolution with no matches", () => {
    const result = detectFramework(tmpRoot);
    expect(result).toEqual({ matches: [], resolution: "generic" });
  });
});

describe("detectFramework — laravel", () => {
  it("detects when composer.json AND artisan are both present", async () => {
    await writeFile(join(tmpRoot, "composer.json"), "{}");
    await writeFile(join(tmpRoot, "artisan"), "#!/usr/bin/env php\n");
    const result = detectFramework(tmpRoot);
    expect(result.resolution).toBe("single");
    expect(result.matches).toEqual(["laravel"]);
  });

  it("does NOT detect with only composer.json", async () => {
    await writeFile(join(tmpRoot, "composer.json"), "{}");
    const result = detectFramework(tmpRoot);
    expect(result.matches).not.toContain("laravel");
  });

  it("does NOT detect with only artisan", async () => {
    await writeFile(join(tmpRoot, "artisan"), "#!/usr/bin/env php\n");
    const result = detectFramework(tmpRoot);
    expect(result.matches).not.toContain("laravel");
  });
});

describe("detectFramework — nextjs", () => {
  it.each(["js", "ts", "mjs", "cjs"])("detects with next.config.%s", async (ext) => {
    await writeFile(join(tmpRoot, `next.config.${ext}`), "module.exports={}");
    const result = detectFramework(tmpRoot);
    expect(result.matches).toEqual(["nextjs"]);
  });

  it("does NOT detect with package.json alone (no next.config.*)", async () => {
    await writeFile(join(tmpRoot, "package.json"), "{}");
    const result = detectFramework(tmpRoot);
    expect(result.matches).not.toContain("nextjs");
  });
});

describe("detectFramework — python", () => {
  it.each([
    ["pyproject.toml", "[project]\nname='x'\n"],
    ["manage.py", "#!/usr/bin/env python\n"],
    ["requirements.txt", "flask==2.0\n"],
  ])("detects with %s alone", async (filename, content) => {
    await writeFile(join(tmpRoot, filename), content);
    const result = detectFramework(tmpRoot);
    expect(result.matches).toEqual(["python"]);
  });
});

describe("detectFramework — rails", () => {
  it("detects when Gemfile AND config/routes.rb are both present", async () => {
    await writeFile(join(tmpRoot, "Gemfile"), "source 'https://rubygems.org'\n");
    await mkdir(join(tmpRoot, "config"));
    await writeFile(
      join(tmpRoot, "config", "routes.rb"),
      "Rails.application.routes.draw do\nend\n",
    );
    const result = detectFramework(tmpRoot);
    expect(result.matches).toEqual(["rails"]);
  });

  it("does NOT detect with only Gemfile", async () => {
    await writeFile(join(tmpRoot, "Gemfile"), "source 'https://rubygems.org'\n");
    const result = detectFramework(tmpRoot);
    expect(result.matches).not.toContain("rails");
  });

  it("does NOT detect with only config/routes.rb", async () => {
    await mkdir(join(tmpRoot, "config"));
    await writeFile(join(tmpRoot, "config", "routes.rb"), "");
    const result = detectFramework(tmpRoot);
    expect(result.matches).not.toContain("rails");
  });
});

describe("detectFramework — lovable", () => {
  it("detects when .lovable/ directory exists", async () => {
    await mkdir(join(tmpRoot, ".lovable"));
    const result = detectFramework(tmpRoot);
    expect(result.matches).toEqual(["lovable"]);
  });

  it("does NOT detect when .lovable is a regular file", async () => {
    await writeFile(join(tmpRoot, ".lovable"), "");
    const result = detectFramework(tmpRoot);
    expect(result.matches).not.toContain("lovable");
  });
});

describe("detectFramework — ambiguous", () => {
  it("returns ambiguous resolution with multiple matches sorted alphabetically", async () => {
    // Create laravel + nextjs + python signatures.
    await writeFile(join(tmpRoot, "composer.json"), "{}");
    await writeFile(join(tmpRoot, "artisan"), "");
    await writeFile(join(tmpRoot, "next.config.js"), "");
    await writeFile(join(tmpRoot, "pyproject.toml"), "[project]\nname='x'\n");

    const result = detectFramework(tmpRoot);
    expect(result.resolution).toBe("ambiguous");
    expect(result.matches).toEqual(["laravel", "nextjs", "python"]);
  });

  it("recommended is laravel when laravel + rails both match (laravel > rails priority)", async () => {
    await writeFile(join(tmpRoot, "composer.json"), "{}");
    await writeFile(join(tmpRoot, "artisan"), "");
    await writeFile(join(tmpRoot, "Gemfile"), "");
    await mkdir(join(tmpRoot, "config"));
    await writeFile(join(tmpRoot, "config", "routes.rb"), "");

    const result = detectFramework(tmpRoot);
    expect(result.resolution).toBe("ambiguous");
    expect(result.matches).toEqual(["laravel", "rails"]);
    expect(result.recommended).toBe("laravel");
  });

  it("recommended is rails when rails + nextjs match (rails > nextjs priority)", async () => {
    await writeFile(join(tmpRoot, "Gemfile"), "");
    await mkdir(join(tmpRoot, "config"));
    await writeFile(join(tmpRoot, "config", "routes.rb"), "");
    await writeFile(join(tmpRoot, "next.config.js"), "");

    const result = detectFramework(tmpRoot);
    expect(result.resolution).toBe("ambiguous");
    expect(result.recommended).toBe("rails");
  });

  it("recommended is nextjs when nextjs + python + lovable match", async () => {
    await writeFile(join(tmpRoot, "next.config.js"), "");
    await writeFile(join(tmpRoot, "pyproject.toml"), "[project]\nname='x'\n");
    await mkdir(join(tmpRoot, ".lovable"));

    const result = detectFramework(tmpRoot);
    expect(result.resolution).toBe("ambiguous");
    expect(result.matches).toEqual(["lovable", "nextjs", "python"]);
    expect(result.recommended).toBe("nextjs");
  });
});

describe("detectFramework — single resolution semantics", () => {
  it("does NOT include `recommended` when only one match", async () => {
    await writeFile(join(tmpRoot, "composer.json"), "{}");
    await writeFile(join(tmpRoot, "artisan"), "");
    const result = detectFramework(tmpRoot);
    expect(result.resolution).toBe("single");
    expect(result.recommended).toBeUndefined();
  });

  it("does NOT include `recommended` for generic", () => {
    const result = detectFramework(tmpRoot);
    expect(result.resolution).toBe("generic");
    expect(result.recommended).toBeUndefined();
  });
});
