import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { IconX } from "./Icons";

interface Props {
  tags: string[];
  onAdd: (name: string) => void;
  onRemove: (name: string) => void;
  datalistId?: string;
}

export function TagEditor({ tags, onAdd, onRemove, datalistId = "tag-suggestions" }: Props) {
  const [value, setValue] = useState("");
  const { data: allTags } = useQuery({ queryKey: ["tags"], queryFn: () => api.tags.list() });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const name = value.trim();
    if (!name || tags.includes(name)) return;
    onAdd(name);
    setValue("");
  }

  return (
    <div>
      {tags.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {tags.map((t) => (
            <span key={t} className="tag-chip">
              {t}
              <button type="button" onClick={() => onRemove(t)} aria-label={`Remove tag ${t}`} title={`Remove tag ${t}`}>
                <IconX size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <form onSubmit={submit} style={{ display: "flex", gap: 6 }}>
        <input
          list={datalistId}
          type="text"
          placeholder="Add tag..."
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <datalist id={datalistId}>
          {(allTags ?? []).map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        <button className="btn" type="submit" disabled={!value.trim()}>
          Add
        </button>
      </form>
    </div>
  );
}
