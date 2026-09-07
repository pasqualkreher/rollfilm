import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

interface Props {
  value: string;
  onChange: (value: string) => void;
  // Called with the tag to add - either the typed text (Enter) or a
  // suggestion the user picked from the list.
  onSubmit: (name: string) => void;
  // Existing tag names to offer. Tags in `exclude` (already on the photo)
  // are left out, since offering them would only produce a no-op.
  suggestions: string[];
  exclude?: string[];
  placeholder?: string;
  ariaLabel?: string;
  title?: string;
  invalid?: boolean;
}

// A text field with a suggestion menu, replacing the native <datalist> that
// used to sit under the tag inputs. The browser draws a datalist in its own
// white, unstyled popup that ignored the app's skin; this one reuses the
// Dropdown's menu classes, so it looks like the combo boxes in the filter bar.
//
// Behaviour: focusing the box lists every known tag, typing narrows the
// list, arrows walk it, Enter takes the highlighted entry - or, with nothing
// highlighted, the typed text as a new tag. Clicking an entry adds it
// straight away. The menu is portalled and fixed-positioned like Dropdown's,
// so the sidebar's overflow can't clip it, and any scroll or resize closes it
// rather than leaving it stranded.
export function TagSuggestInput({
  value,
  onChange,
  onSubmit,
  suggestions,
  exclude = [],
  placeholder,
  ariaLabel,
  title,
  invalid,
}: Props) {
  const [open, setOpen] = useState(false);
  // -1: nothing highlighted, Enter submits the typed text.
  const [cursor, setCursor] = useState(-1);
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const needle = value.trim().toLowerCase();
  const matches = suggestions.filter(
    (t) => !exclude.includes(t) && (!needle || t.toLowerCase().includes(needle))
  );

  function close() {
    setOpen(false);
    setPos(null);
    setCursor(-1);
  }

  function pick(name: string) {
    onSubmit(name);
    close();
    // The box stays the place to type the next tag.
    inputRef.current?.focus();
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setCursor(0);
        return;
      }
      if (matches.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setCursor((c) => (c + step + matches.length) % matches.length);
    } else if (e.key === "Enter") {
      if (open && cursor >= 0 && cursor < matches.length) {
        e.preventDefault();
        pick(matches[cursor]);
      }
      // Otherwise the surrounding form submits the typed text.
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (inputRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      close();
    }
    function onScroll(e: Event) {
      if (menuRef.current?.contains(e.target as Node)) return;
      close();
    }
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  // Anchor under the box, flip above when the viewport bottom is near - the
  // same placement Dropdown does for its menu.
  useLayoutEffect(() => {
    if (!open || !menuRef.current || !inputRef.current) return;
    const menu = menuRef.current;
    const anchor = inputRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - anchor.bottom;
    const spaceAbove = anchor.top;
    const up = menu.offsetHeight + 8 > spaceBelow && spaceAbove > spaceBelow;
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - menu.offsetWidth - 8));
    setPos({
      left,
      minWidth: anchor.width,
      ...(up ? { bottom: window.innerHeight - anchor.top + 6 } : { top: anchor.bottom + 6 }),
    });
  }, [open, matches.length]);

  useEffect(() => {
    if (!open) return;
    menuRef.current
      ?.querySelector<HTMLElement>(".dropdown-option.cursor")
      ?.scrollIntoView({ block: "nearest" });
  }, [open, cursor]);

  const showMenu = open && matches.length > 0;

  return (
    <>
      <input
        ref={inputRef}
        type="text"
        placeholder={placeholder}
        value={value}
        title={title}
        aria-label={ariaLabel}
        aria-invalid={invalid ? true : undefined}
        aria-autocomplete="list"
        aria-expanded={showMenu}
        autoComplete="off"
        onChange={(e) => {
          onChange(e.target.value);
          setCursor(-1);
          if (!open) setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onKeyDown={onKey}
      />
      {showMenu &&
        createPortal(
          <div
            className="dropdown-menu"
            style={pos ?? { visibility: "hidden", left: 0, top: 0 }}
            role="listbox"
            ref={menuRef}
            // Keep the focus in the box while an entry is clicked, so the
            // form's blur handlers don't fire in between.
            onMouseDown={(e) => e.preventDefault()}
          >
            {matches.map((t, i) => (
              <button
                key={t}
                type="button"
                role="option"
                aria-selected={i === cursor}
                className={`dropdown-option${i === cursor ? " cursor" : ""}`}
                onClick={() => pick(t)}
              >
                {t}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
