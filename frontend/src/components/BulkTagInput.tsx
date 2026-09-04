import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { IconPlus } from "./Icons";
import { autoTagMessage, isAutoTag } from "../utils/autoTags";

interface Props {
  onAdd: (name: string) => void;
}

export function BulkTagInput({ onAdd }: Props) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { data: allTags } = useQuery({ queryKey: ["tags"], queryFn: () => api.tags.list() });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const name = value.trim();
    if (!name) return;
    if (isAutoTag(name)) {
      setError(autoTagMessage(name));
      return;
    }
    setError(null);
    onAdd(name);
    setValue("");
  }

  return (
    <form onSubmit={submit} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <input
        list="bulk-tag-suggestions"
        type="text"
        placeholder="Add tag to selection..."
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          if (error) setError(null);
        }}
        title={error ?? undefined}
        aria-invalid={error ? true : undefined}
      />
      <datalist id="bulk-tag-suggestions">
        {(allTags ?? [])
          .filter((t) => !isAutoTag(t))
          .map((t) => (
            <option key={t} value={t} />
          ))}
      </datalist>
      <button
        className="btn"
        type="submit"
        disabled={!value.trim()}
        title="Add this tag to the selection"
        aria-label="Add this tag to the selection"
      >
        <IconPlus size={14} />
      </button>
      {error && (
        <span className="tag-input-error" role="alert" style={{ marginTop: 0 }}>
          {error}
        </span>
      )}
    </form>
  );
}
