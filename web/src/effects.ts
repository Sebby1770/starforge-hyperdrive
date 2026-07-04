/** React Bits–inspired vanilla effects: spotlight cards, aurora, border glow. */

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
    if (event.key === "h" || event.key === "H") {
      if (event.target instanceof HTMLInputElement) {
        return;
      }
      toggle();
      event.preventDefault();
    }
  };

  window.addEventListener("keydown", handleKey);
  return () => {
    hideButton.removeEventListener("click", toggle);
    window.removeEventListener("keydown", handleKey);
  };
}