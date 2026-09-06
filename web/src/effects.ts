/** React Bits–inspired vanilla effects: spotlight cards, aurora, border glow. */

import { isInteractiveShortcutTarget } from "./keyboard";

export function initSpotlightCards(root: ParentNode = document) {
  const cards = Array.from(root.querySelectorAll<HTMLElement>(".spotlight-card"));

  if (cards.length === 0) {
    return () => {};
  }

  const handleMove = (event: PointerEvent) => {
    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      card.style.setProperty("--spot-x", `${x}px`);
      card.style.setProperty("--spot-y", `${y}px`);
    }
  };

  window.addEventListener("pointermove", handleMove, { passive: true });
  return () => window.removeEventListener("pointermove", handleMove);
}

export function initUiChrome() {
  const shell = document.querySelector<HTMLElement>(".app-shell");
  const hideButton = document.querySelector<HTMLButtonElement>("#hide-ui");
  const hints = document.querySelector<HTMLElement>(".keyboard-hints");

  if (!shell || !hideButton) {
    return () => {};
  }

  let hidden = false;

  const toggle = () => {
    hidden = !hidden;
    shell.classList.toggle("ui-hidden", hidden);
    hideButton.textContent = hidden ? "Show UI" : "Hide UI";
    hideButton.setAttribute("aria-pressed", String(hidden));
    if (hints) {
      hints.hidden = hidden;
    }
  };

  hideButton.addEventListener("click", toggle);

  const handleKey = (event: KeyboardEvent) => {
    if (event.key !== "h" && event.key !== "H") {
      return;
    }

    // Hide-UI is a global shortcut like every other one, so it has to yield to
    // native activation in exactly the same cases. Checking only for a text
    // input let `H` fire while a button or slider held focus, which contradicted
    // the documented shortcut contract and stole the key from the control.
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      isInteractiveShortcutTarget(event.target) ||
      isInteractiveShortcutTarget(document.activeElement)
    ) {
      return;
    }

    toggle();
    event.preventDefault();
  };

  window.addEventListener("keydown", handleKey);
  return () => {
    hideButton.removeEventListener("click", toggle);
    window.removeEventListener("keydown", handleKey);
  };
}