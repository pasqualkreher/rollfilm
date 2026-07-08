import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

interface Props {
  onAdd: (name: string) => void;
}

export function BulkTagInput({ onAdd }: Props) {
  const [value, setValue] = useState("");
  const { data: allTags } = useQuery({ queryKey: ["tags"], queryFn: () => api.tags.list() });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const name = value.trim();
    if (!name) return;
    onAdd(name);
    setValue("");
  }

  return (
    <form onSubmit={submit} style={{ display: "inline-flex", gap: 6 }}>
      <input
        list="bulk-tag-suggestions"
        type="text"
        placeholder="Add tag to selection..."
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <datalist id="bulk-tag-suggestions">
        {(allTags ?? []).map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <button className="btn" type="submit" disabled={!value.trim()}>
        Add tag
      </button>
    </form>
  );
}
