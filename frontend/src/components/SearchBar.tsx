import { useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { IconSearch, IconX } from "./Icons";

// Which routes have a grid that search filters in place. On any other page a
// search falls back to the Library. Album detail keeps its own path so the
// search stays scoped to that album.
function searchBaseFor(pathname: string): string {
  return pathname.startsWith("/albums/") ? pathname : "/";
}

export function SearchBar() {
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [value, setValue] = useState(params.get("q") ?? "");

  // Keep the box in sync with the active query when it changes elsewhere -
  // e.g. navigating between grids, or clearing the search from the results
  // header - so it always reflects what's actually filtering the grid.
  useEffect(() => {
    setValue(params.get("q") ?? "");
  }, [params]);

  function submit(next: string) {
    const base = searchBaseFor(location.pathname);
    // Searching refines the view the user is looking at, so it keeps that
    // view's other query params - the Library holds its filter set there, and
    // rebuilding the query string from just `q` silently cleared every active
    // filter (and clearing the search cleared them a second time). Params from
    // a different page are dropped: they don't describe the grid we land on.
    const carried = base === location.pathname ? new URLSearchParams(params) : new URLSearchParams();
    const query = next.trim();
    if (query) carried.set("q", query);
    else carried.delete("q");
    const qs = carried.toString();
    navigate(qs ? `${base}?${qs}` : base);
  }

  return (
    <form
      className="search-bar"
      onSubmit={(e) => {
        e.preventDefault();
        submit(value);
      }}
    >
      <span className="search-icon" aria-hidden>
        <IconSearch size={14} />
      </span>
      <input
        type="text"
        placeholder="Search the current view... e.g. 'dog on a beach'"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      {value && (
        <button
          type="button"
          className="search-clear"
          aria-label="Clear search"
          onClick={() => {
            setValue("");
            submit("");
          }}
        >
          <IconX size={12} />
        </button>
      )}
    </form>
  );
}
