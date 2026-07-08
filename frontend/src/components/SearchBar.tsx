import { useState } from "react";
import { useNavigate } from "react-router-dom";

export function SearchBar() {
  const [value, setValue] = useState("");
  const navigate = useNavigate();

  return (
    <form
      className="search-bar"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) navigate(`/search?q=${encodeURIComponent(value.trim())}`);
      }}
    >
      <input
        type="text"
        placeholder="Search photos... e.g. 'dog on a beach'"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
    </form>
  );
}
