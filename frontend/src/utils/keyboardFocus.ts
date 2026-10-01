// Is the keyboard busy typing into this element? Only real text entry counts -
// a text-like <input>, a <textarea>, contenteditable. Buttons, checkboxes and
// sliders keep the focus after a click without having any use for letters or
// digits, so single-key shortcuts must keep working while they hold it.
const NON_TEXT_INPUT_TYPES = new Set([
  "button", "checkbox", "color", "file", "image", "radio", "range", "reset", "submit",
]);

export function isTextEntry(el: HTMLElement | null | undefined): boolean {
  if (!el) return false;
  if (el.isContentEditable || el.tagName === "TEXTAREA") return true;
  return el.tagName === "INPUT" && !NON_TEXT_INPUT_TYPES.has((el as HTMLInputElement).type);
}
