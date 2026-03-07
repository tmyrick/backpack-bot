import { useState, useRef, useEffect, useCallback } from "react";

export interface SearchableSelectOption {
  value: string;
  label: string;
}

interface SearchableSelectProps {
  options: SearchableSelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  loading?: boolean;
  loadingText?: string;
}

export default function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = "Select...",
  disabled = false,
  loading = false,
  loadingText = "Loading...",
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [highlightIndex, setHighlightIndex] = useState(-1);

  const selectedLabel =
    options.find((o) => o.value === value)?.label || "";

  const filtered = query
    ? options.filter((o) =>
        o.label.toLowerCase().includes(query.toLowerCase()),
      )
    : options;

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Reset highlight when filtered list changes
  useEffect(() => {
    setHighlightIndex(-1);
  }, [query]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightIndex >= 0 && listRef.current) {
      const el = listRef.current.children[highlightIndex] as HTMLElement;
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [highlightIndex]);

  const handleSelect = useCallback(
    (val: string) => {
      onChange(val);
      setOpen(false);
      setQuery("");
    },
    [onChange],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlightIndex((i) => Math.min(i + 1, filtered.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlightIndex((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (highlightIndex >= 0 && filtered[highlightIndex]) {
          handleSelect(filtered[highlightIndex].value);
        }
        break;
      case "Escape":
        e.preventDefault();
        setOpen(false);
        setQuery("");
        break;
    }
  };

  const handleOpen = () => {
    if (disabled || loading) return;
    setOpen(true);
    setQuery("");
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange("");
    setQuery("");
  };

  if (loading) {
    return (
      <div className="w-full px-3 py-2 border border-stone-600 rounded-lg bg-stone-900 text-stone-500 cursor-not-allowed">
        {loadingText}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      {/* Trigger / display */}
      {!open ? (
        <button
          type="button"
          onClick={handleOpen}
          disabled={disabled}
          className="w-full px-3 py-2 border border-stone-600 rounded-lg bg-stone-900 text-left flex items-center justify-between focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <span className={value ? "text-stone-100" : "text-stone-500"}>
            {value ? selectedLabel : placeholder}
          </span>
          <span className="flex items-center gap-1 shrink-0">
            {value && (
              <span
                role="button"
                tabIndex={-1}
                onClick={handleClear}
                className="p-0.5 rounded hover:bg-stone-700 text-stone-500 hover:text-stone-300"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </span>
            )}
            <svg className="w-4 h-4 text-stone-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </span>
        </button>
      ) : (
        <div className="w-full border border-emerald-500 rounded-lg bg-stone-900 ring-2 ring-emerald-500">
          <div className="flex items-center px-3 py-2 gap-2">
            <svg className="w-4 h-4 text-stone-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={`Search ${options.length} options...`}
              className="flex-1 bg-transparent text-stone-100 placeholder-stone-500 outline-none text-sm"
              autoComplete="off"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="p-0.5 rounded hover:bg-stone-700 text-stone-500 hover:text-stone-300"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Dropdown list */}
      {open && (
        <ul
          ref={listRef}
          className="absolute z-50 mt-1 w-full max-h-60 overflow-auto rounded-lg border border-stone-600 bg-stone-900 shadow-xl"
        >
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-sm text-stone-500">
              {query ? "No matches" : "No options"}
            </li>
          ) : (
            filtered.map((opt, i) => (
              <li
                key={opt.value}
                onMouseDown={(e) => {
                  e.preventDefault();
                  handleSelect(opt.value);
                }}
                onMouseEnter={() => setHighlightIndex(i)}
                className={`px-3 py-2 text-sm cursor-pointer transition-colors ${
                  opt.value === value
                    ? "bg-emerald-900/50 text-emerald-300"
                    : i === highlightIndex
                      ? "bg-stone-700 text-stone-100"
                      : "text-stone-300 hover:bg-stone-800"
                }`}
              >
                {opt.label}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
