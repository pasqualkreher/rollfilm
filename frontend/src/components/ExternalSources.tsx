import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { DirectoryPicker } from "./DirectoryPicker";

function formatScanned(iso: string | null): string {
  if (!iso) return "never scanned";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "never scanned" : `last scanned ${d.toLocaleString()}`;
}

export function ExternalSources() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [picking, setPicking] = useState(false);

  const { data: sources } = useQuery({
    queryKey: ["sources"],
    queryFn: () => api.sources.list(),
    // Keep polling while any source is mid-scan so counts/progress update live.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((s) => s.scanning) ? 1500 : false,
  });

  const addSource = useMutation({
    mutationFn: () => api.sources.add(name.trim(), path.trim()),
    onSuccess: () => {
      setName("");
      setPath("");
      queryClient.invalidateQueries({ queryKey: ["sources"] });
      queryClient.invalidateQueries({ queryKey: ["images"] });
    },
  });

  const scan = useMutation({
    mutationFn: (id: string) => api.sources.scan(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["sources"] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.sources.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sources"] });
      queryClient.invalidateQueries({ queryKey: ["images"] });
    },
  });

  return (
    <section style={{ marginBottom: 32 }}>
      <h3 className="section-title" style={{ fontSize: 15 }}>
        External photo sources
      </h3>
      <p style={{ color: "var(--text-muted)" }}>
        Index an existing collection (e.g. a NAS or big folder) <strong>in place</strong>. The files
        <strong> stay exactly where they are</strong> - they are never copied or moved into the app,
        only added to your library. You can add several sources; they're re-scanned for new files each
        time the app starts, and whenever you press <em>Scan now</em>. (Photos you bring in via the{" "}
        <em>Import</em> tab are the ones copied into the app's managed library.)
      </p>
      <p style={{ color: "var(--text-muted)" }}>
        The folder must be visible <strong>inside the backend container</strong> (mount it via the{" "}
        <code>sources</code> volume in <code>docker-compose.yml</code>), then use <em>Browse</em> to
        pick it - e.g. <code>/sources/nas-photos</code>.
      </p>

      <div className="import-toolbar" style={{ flexWrap: "wrap" }}>
        <input
          type="text"
          placeholder="Name (e.g. NAS photos)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ minWidth: 180 }}
        />
        <input
          type="text"
          placeholder="/sources/nas-photos"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          style={{ minWidth: 220, flex: 1 }}
        />
        <button className="btn" onClick={() => setPicking(true)}>
          Browse…
        </button>
        <button
          className="btn primary"
          onClick={() => addSource.mutate()}
          disabled={!path.trim() || addSource.isPending}
        >
          {addSource.isPending ? "Adding..." : "Add & scan"}
        </button>
      </div>
      {addSource.isError && (
        <p style={{ color: "var(--danger)" }}>{(addSource.error as Error).message}</p>
      )}

      {picking && (
        <DirectoryPicker
          onClose={() => setPicking(false)}
          onSelect={(chosen) => {
            setPath(chosen);
            // Default the name to the folder's own name if the user hasn't typed one.
            if (!name.trim()) {
              const base = chosen.replace(/\/+$/, "").split("/").pop();
              if (base) setName(base);
            }
            setPicking(false);
          }}
        />
      )}

      {sources && sources.length > 0 && (
        <div className="source-list">
          {sources.map((s) => (
            <div key={s.id} className="source-row">
              <div className="source-row-main">
                <span className="source-name">{s.name}</span>
                <span className="source-path">{s.path}</span>
                <span className="source-meta">
                  {s.image_count} photo{s.image_count === 1 ? "" : "s"} · {formatScanned(s.last_scanned_at)}
                  {s.scanning && <span className="source-scanning"> · scanning…</span>}
                </span>
              </div>
              <div className="source-row-actions">
                <button className="btn" onClick={() => scan.mutate(s.id)} disabled={s.scanning}>
                  {s.scanning ? "Scanning…" : "Scan now"}
                </button>
                <button
                  className="btn"
                  style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Remove "${s.name}"? This removes its ${s.image_count} indexed photo(s) from the ` +
                          `library. The original files on the source are NOT deleted.`
                      )
                    ) {
                      remove.mutate(s.id);
                    }
                  }}
                  disabled={remove.isPending}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
