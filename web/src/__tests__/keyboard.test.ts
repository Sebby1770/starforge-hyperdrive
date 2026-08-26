/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";

import { isInteractiveShortcutTarget } from "../keyboard";

function element(html: string): Element {
  const host = document.createElement("div");
  host.innerHTML = html;
  const child = host.firstElementChild;
  if (!child) {
    throw new Error("Fixture produced no element.");
  }
  return child;
}

describe("isInteractiveShortcutTarget", () => {
  it("ignores non-element targets", () => {
    expect(isInteractiveShortcutTarget(null)).toBe(false);
    expect(isInteractiveShortcutTarget(new EventTarget())).toBe(false);
  });

  it("protects native controls so Space and letters keep their meaning", () => {
    for (const html of [
      "<button>Play</button>",
      "<input type='range'>",
      "<textarea></textarea>",
      "<select><option>a</option></select>",
      "<a href='#x'>link</a>",
      "<summary>more</summary>",
      "<div contenteditable='true'>notes</div>"
    ]) {
      expect(isInteractiveShortcutTarget(element(html))).toBe(true);
    }
  });

  it("protects ARIA widgets that behave like controls", () => {
    for (const role of ["button", "slider", "textbox", "combobox", "menuitem", "tab"]) {
      expect(isInteractiveShortcutTarget(element(`<div role='${role}'></div>`))).toBe(true);
    }
  });

  it("matches an interactive ancestor, not just the exact target", () => {
    const button = element("<button><span id='label'>Play</span></button>");
    document.body.append(button);
    const label = button.querySelector("#label");
    expect(label).not.toBeNull();
    expect(isInteractiveShortcutTarget(label)).toBe(true);
  });

  it("lets shortcuts through for inert content", () => {
    expect(isInteractiveShortcutTarget(element("<p>status text</p>"))).toBe(false);
    expect(isInteractiveShortcutTarget(element("<canvas></canvas>"))).toBe(false);
    expect(isInteractiveShortcutTarget(element("<div contenteditable='false'></div>"))).toBe(false);
    expect(isInteractiveShortcutTarget(element("<div tabindex='-1'></div>"))).toBe(false);
  });
});
