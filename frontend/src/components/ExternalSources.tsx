import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { DirectoryPicker } from "./DirectoryPicker";
import { useAppDialogs } from "./AppDialogs";

function formatScanned(iso: string | null): string {
  if (!iso) return "never scanned";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "never scanned" : `last scanned ${d.toLocaleString()}`;
}

export function ExternalSources() {
  const queryClient = useQueryClient();
  const dialogs = useAppDialogs();
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [picking, setPicking] = useState(false);

  // In the desktop app we get a real OS folder dialog; on the web we fall back
  // to the server-side directory browser (DirectoryPicker).
  const electron = typeof window !== "undefined" ? window.photoManager : undefined;

  // Set the chosen folder as the path, defaulting the name to the folder's own
  // name if the user hasn't typed one.
  const applyChosenFolder = (chosen: string) => {
    setPath(chosen);
    if (!name.trim()) {
      const base = chosen.replace(/\/+$/, "").split("/").pop();
      if (base) setName(base);
    }
  };

  const handleBrowse = async () => {
    if (electron?.pickFolder) {
      const chosen = await electron.pickFolder();
      if (chosen) applyChosenFolder(chosen);
    } else {
      setPicking(true);
    }
  };

  const { data: sources } = useQuery({
    queryKey: ["sources"],
    queryFn: () => api.sources.list(),
    // Poll while any source is mid-scan (live counts/progress) and also on a
    // slow tick so plugging in / removing a drive flips its status without a
    // manual refresh.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((s) => s.scanning) ? 1500 : 5000,
  });

  // A source is scanned in the background after it's added/re-scanned, so the
  // add mutation's one-time invalidate fires before any photo is indexed. Watch
  // the polled source list and refresh the Library whenever a source's photo
  // count or scanning status changes, so new photos show up live without having
  // to switch windows to trigger a refetch-on-focus.
  const sourcesSig = (sources ?? [])
    .map((s) => `${s.id}:${s.image_count}:${s.scanning}`)
    .join("|");
  useEffect(() => {
    if (sources) queryClient.invalidateQueries({ queryKey: ["images"] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcesSig]);

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
    <section className="import-panel">
      <h3 className="section-title">External photo sources</h3>
      <p className="import-panel-desc">
        Show photos from a folder — like a NAS or an archive — without copying them in. The files
        stay where they are, and each source is re-scanned at startup and when you press{" "}
        <em>Scan now</em>.
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
        <button className="btn" onClick={handleBrowse}>
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
        <p className="status-note status-note--error">{(addSource.error as Error).message}</p>
      )}

      {picking && (
        <DirectoryPicker
          onClose={() => setPicking(false)}
          onSelect={(chosen) => {
            applyChosenFolder(chosen);
            setPicking(false);
          }}
        />
      )}

      {sources && sources.length > 0 && (
        <div className="source-list">
          {sources.map((s) => (
            <div key={s.id} className={`source-row${s.available ? "" : " disconnected"}`}>
              <div className="source-row-main">
                <span className="source-name">
                  {s.name}
                  {!s.available && <span className="source-disconnected-badge">Disconnected</span>}
                </span>
                <span className="source-path">{s.path}</span>
                <span className="source-meta">
                  {s.image_count} photo{s.image_count === 1 ? "" : "s"} · {formatScanned(s.last_scanned_at)}
                  {s.scanning && <span className="source-scanning"> · scanning…</span>}
                  {!s.available && (
                    <span className="source-disconnected-note">
                      {" "}· not connected — its photos are hidden until you reconnect it
                    </span>
                  )}
                </span>
              </div>
              <div className="source-row-actions">
                <button
                  className="btn"
                  onClick={() => scan.mutate(s.id)}
                  disabled={s.scanning || !s.available}
                  title={
                    !s.available
                      ? "Reconnect the drive/folder to scan it"
                      : "Re-index the whole folder - new files are added and photos you deleted from this source come back"
                  }
                >
                  {s.scanning ? "Scanning…" : "Scan now"}
                </button>
                <button
                  className="btn danger"
                  onClick={async () => {
                    if (
                      await dialogs.confirm({
                        title: `Remove "${s.name}"?`,
                        message:
                          `This removes its ${s.image_count} indexed photo(s) from the library. ` +
                          `The original files on the source are NOT deleted.`,
                        confirmLabel: "Remove",
                        danger: true,
                      })
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
