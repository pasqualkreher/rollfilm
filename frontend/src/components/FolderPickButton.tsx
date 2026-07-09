import { useEffect, useRef, type ReactNode } from "react";
import { pickImportableFiles, sourceLabelFor } from "../utils/folderPick";

interface Props {
  onPicked: (files: File[], label: string) => void;
  onEmpty?: () => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * The browser's native folder chooser (the same OS dialog the Import screen
 * uses). webkitdirectory/directory are set imperatively and the change is read
 * via a plain DOM listener - React's synthetic event system has known quirks
 * around file inputs that can silently swallow the change event.
 */
export function FolderPickButton({ onPicked, onEmpty, disabled, className, children }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.setAttribute("webkitdirectory", "");
    el.setAttribute("directory", "");

    function onChange(e: Event) {
      const target = e.target as HTMLInputElement;
      const fileList = target.files;
      if (!fileList || fileList.length === 0) {
        target.value = "";
        return;
      }
      // input.files is a live list - snapshot it before clearing target.value.
      const picked = pickImportableFiles(fileList);
      const label = sourceLabelFor(fileList);
      target.value = "";
      if (picked.length === 0) {
        onEmpty?.();
        return;
      }
      onPicked(picked, label);
    }

    el.addEventListener("change", onChange);
    return () => el.removeEventListener("change", onChange);
  }, [onPicked, onEmpty]);

  return (
    <>
      <input ref={inputRef} type="file" multiple style={{ display: "none" }} />
      <button
        type="button"
        className={className}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        {children}
      </button>
    </>
  );
}
