export const INTERACTIVE_SHORTCUT_SELECTOR = [
  "a[href]",
  "area[href]",
  "button",
  "input",
  "select",
  "textarea",
  "label",
  "summary",
  "iframe",
  "object",
  "embed",
  "audio[controls]",
  "video[controls]",
  "[contenteditable]:not([contenteditable='false'])",
  "[onclick]",
  "[role='button']",
  "[role='link']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='switch']",
  "[role='tab']",
  "[role='menuitem']",
  "[role='option']",
  "[role='slider']",
  "[role='spinbutton']",
  "[role='textbox']",
  "[role='combobox']",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

type ClosestTarget = EventTarget & {
  closest: (selectors: string) => unknown;
};

export function isInteractiveShortcutTarget(target: EventTarget | null) {
  if (!hasClosest(target)) {
    return false;
  }

  return target.closest(INTERACTIVE_SHORTCUT_SELECTOR) !== null;
}

function hasClosest(target: EventTarget | null): target is ClosestTarget {
  return (
    target !== null &&
    typeof (target as EventTarget & { closest?: unknown }).closest === "function"
  );
}
