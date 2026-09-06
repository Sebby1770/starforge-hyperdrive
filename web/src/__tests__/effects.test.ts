/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from "vitest";
import { initUiChrome } from "../effects";

function mountChrome() {
  document.body.innerHTML = `
    <main class="app-shell">
      <button id="hide-ui" aria-pressed="false">Hide UI</button>
      <p class="keyboard-hints">hints</p>
      <button id="other">Other</button>
      <input id="seed" type="number" />
    </main>
  `;

  return {
    shell: document.querySelector<HTMLElement>(".app-shell")!,
    hideButton: document.querySelector<HTMLButtonElement>("#hide-ui")!,
    otherButton: document.querySelector<HTMLButtonElement>("#other")!,
    seedInput: document.querySelector<HTMLInputElement>("#seed")!
  };
}

function pressH(target: EventTarget) {
  const event = new KeyboardEvent("keydown", { key: "h", bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe("initUiChrome", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("toggles the chrome when the shortcut fires from the document body", () => {
    const { shell, hideButton } = mountChrome();
    initUiChrome();

    pressH(document.body);
    expect(shell.classList.contains("ui-hidden")).toBe(true);
    expect(hideButton.getAttribute("aria-pressed")).toBe("true");

    pressH(document.body);
    expect(shell.classList.contains("ui-hidden")).toBe(false);
    expect(hideButton.getAttribute("aria-pressed")).toBe("false");
  });

  it("still toggles from the button that owns the shortcut", () => {
    const { shell, hideButton } = mountChrome();
    initUiChrome();

    hideButton.click();
    expect(shell.classList.contains("ui-hidden")).toBe(true);
  });

  // Regression: the handler used to check only for HTMLInputElement, so `H`
  // fired while any button or slider held focus. That both contradicted the
  // documented shortcut contract and stole the key from the focused control.
  it("yields to focused interactive elements", () => {
    const { shell, otherButton, seedInput } = mountChrome();
    initUiChrome();

    otherButton.focus();
    const buttonEvent = pressH(otherButton);
    expect(shell.classList.contains("ui-hidden")).toBe(false);
    expect(buttonEvent.defaultPrevented).toBe(false);

    seedInput.focus();
    pressH(seedInput);
    expect(shell.classList.contains("ui-hidden")).toBe(false);
  });

  it("yields to browser and OS shortcuts that also use H", () => {
    const { shell } = mountChrome();
    initUiChrome();

    for (const modifier of ["metaKey", "ctrlKey", "altKey"] as const) {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "h", bubbles: true, [modifier]: true })
      );
      expect(shell.classList.contains("ui-hidden")).toBe(false);
    }
  });

  it("does nothing when the chrome is absent", () => {
    document.body.innerHTML = "<main></main>";
    expect(() => initUiChrome()).not.toThrow();
  });
});
