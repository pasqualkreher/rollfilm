import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { IconPlus, IconX } from "./Icons";
import { TagSuggestInput } from "./TagSuggestInput";
import { AUTO_TAG_CHIP_TITLE, autoTagMessage, isAutoTag, withoutMembershipNames } from "../utils/autoTags";

interface Props {
  tags: string[];
  onAdd: (name: string) => void;
  onRemove: (name: string) => void;
}

export function TagEditor({ tags, onAdd, onRemove }: Props) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { data: allTags } = useQuery({ queryKey: ["tags"], queryFn: () => api.tags.list() });
  // "album: <name>" and "canvas: <name>" are not shown here: where a photo
  // is used has its own chips (MembershipChips), so listing the names again
  // as tags only said the same thing twice.
  const shown = withoutMembershipNames(tags);

  function add(raw: string) {
    const name = raw.trim();
    if (!name || tags.includes(name)) return;
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
    <div>
      {shown.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {shown.map((t) => {
            return isAutoTag(t) ? (
              <span key={t} className="tag-chip tag-chip-auto" title={AUTO_TAG_CHIP_TITLE}>
                {t}
              </span>
            ) : (
              <span key={t} className="tag-chip">
                {t}
                <button type="button" onClick={() => onRemove(t)} aria-label={`Remove tag ${t}`} title={`Remove tag ${t}`}>
                  <IconX size={11} />
                </button>
              </span>
            );
          })}
        </div>
      )}
      <form onSubmit={submit} style={{ display: "flex", gap: 6 }}>
        <TagSuggestInput
          placeholder="Add tag..."
          ariaLabel="Add tag"
          value={value}
          onChange={(v) => {
            setValue(v);
            if (error) setError(null);
          }}
          onSubmit={add}
          suggestions={(allTags ?? []).filter((t) => !isAutoTag(t))}
          exclude={tags}
        />
        <button className="btn" type="submit" disabled={!value.trim()} title="Add tag" aria-label="Add tag">
          <IconPlus size={14} />
        </button>
      </form>
      {error && (
        <div className="tag-input-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
