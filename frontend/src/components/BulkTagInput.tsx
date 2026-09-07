import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { IconPlus } from "./Icons";
import { TagSuggestInput } from "./TagSuggestInput";
import { autoTagMessage, isAutoTag } from "../utils/autoTags";

interface Props {
  onAdd: (name: string) => void;
}

export function BulkTagInput({ onAdd }: Props) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { data: allTags } = useQuery({ queryKey: ["tags"], queryFn: () => api.tags.list() });

  function add(raw: string) {
    const name = raw.trim();
    if (!name) return;
    if (isAutoTag(name)) {
      setError(autoTagMessage(name));
      return;
    }
    setError(null);
    onAdd(name);
    setValue("");
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    add(value);
  }

  return (
    <form onSubmit={submit} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <TagSuggestInput
        placeholder="Add tag to selection..."
        ariaLabel="Add tag to selection"
        value={value}
        onChange={(v) => {
          setValue(v);
          if (error) setError(null);
        }}
        onSubmit={add}
        suggestions={(allTags ?? []).filter((t) => !isAutoTag(t))}
        title={error ?? undefined}
        invalid={!!error}
      />
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
