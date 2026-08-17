import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePath = join(rootDir, "web", "src", "keyboard.ts");
const requireFromWeb = createRequire(join(rootDir, "web", "package.json"));
const typescript = requireFromWeb("typescript");
const source = await readFile(sourcePath, "utf8");
const compiled = typescript.transpileModule(source, {
  compilerOptions: {
    module: typescript.ModuleKind.ES2022,
    target: typescript.ScriptTarget.ES2022
  },
  fileName: sourcePath
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const { INTERACTIVE_SHORTCUT_SELECTOR, isInteractiveShortcutTarget } = await import(moduleUrl);

let observedSelector = "";
const nestedInteractiveTarget = {
  closest(selector) {
    observedSelector = selector;
    return { tagName: "BUTTON" };
  }
};
const inertTarget = {
  closest() {
    return null;
  }
};

assert.equal(isInteractiveShortcutTarget(nestedInteractiveTarget), true);
assert.equal(isInteractiveShortcutTarget(inertTarget), false);
assert.equal(isInteractiveShortcutTarget(null), false);
assert.equal(isInteractiveShortcutTarget({}), false);
assert.equal(observedSelector, INTERACTIVE_SHORTCUT_SELECTOR);

for (const requiredSelector of [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "[contenteditable]",
  "[role='button']",
  "[role='link']",
  "[tabindex]"
]) {
  assert.ok(
    INTERACTIVE_SHORTCUT_SELECTOR.includes(requiredSelector),
    `Interactive shortcut guard is missing ${requiredSelector}`
  );
}

console.log("Verified keyboard shortcuts preserve native interactive-element activation.");
