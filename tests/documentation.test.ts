import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");
const docsRoot = resolve(repositoryRoot, "docs");
const markdownFiles = [
  resolve(repositoryRoot, "README.md"),
  ...readdirSync(docsRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name) === ".md")
    .map((entry) => resolve(docsRoot, entry.name)),
];

function relativeMarkdownLinks(markdown: string): readonly string[] {
  return [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
    .map((match) => match[1])
    .filter((link): link is string => link !== undefined)
    .filter((link) => !link.startsWith("#") && !URL.canParse(link));
}

test("documentation has no broken relative links", () => {
  const brokenLinks: string[] = [];

  for (const markdownFile of markdownFiles) {
    const markdown = readFileSync(markdownFile, "utf8");

    for (const link of relativeMarkdownLinks(markdown)) {
      const [path] = link.split("#", 1);

      if (path === undefined || !existsSync(resolve(dirname(markdownFile), path))) {
        brokenLinks.push(`${markdownFile}: ${link}`);
      }
    }
  }

  assert.deepEqual(brokenLinks, []);
});
