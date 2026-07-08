import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { ThumbnailGrid } from "../components/ThumbnailGrid";

export function SearchResults() {
  const [params] = useSearchParams();
  const q = params.get("q") ?? "";

  const { data: results, isLoading } = useQuery({
    queryKey: ["search", q],
    queryFn: () => api.search.query(q),
    enabled: q.length > 0,
  });

  return (
    <div className="page">
      <h2 className="section-title">Results for "{q}"</h2>
      {isLoading ? (
        <div className="empty-state">Searching...</div>
      ) : (
        <ThumbnailGrid images={(results ?? []).map((r) => r.image)} />
      )}
    </div>
  );
}
