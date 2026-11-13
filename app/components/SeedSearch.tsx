'use client';

import { useState, useRef, useEffect, useId } from 'react';

interface SearchResult {
  title: string;
}

interface SeedSearchProps {
  onSearch: (title: string) => void;
  isLoading: boolean;
}

export function SeedSearch({ onSearch, isLoading }: SeedSearchProps) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<SearchResult[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [isSearching, setIsSearching] = useState(false);
  const [searchUnavailable, setSearchUnavailable] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<NodeJS.Timeout>();
  const requestControllerRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const selectionCommittedRef = useRef(false);
  const cacheRef = useRef<Map<string, SearchResult[]>>(new Map());
  const listboxId = useId();

  const trimmedQuery = query.trim();
  // Only treat the search as "empty" once a real response confirms it, never while still loading.
  const showBusyState = !isSearching && trimmedQuery.length > 0 && searchUnavailable;
  const showEmptyState = !isSearching && trimmedQuery.length > 0 && suggestions.length === 0 && !searchUnavailable;
  const optionCount = showEmptyState ? 1 : suggestions.length;
  const listVisible = showSuggestions && (suggestions.length > 0 || showEmptyState || showBusyState);

  useEffect(() => {
    const trimmed = query.trim();
    setSearchUnavailable(false);

    if (trimmed.length < 1) {
      requestControllerRef.current?.abort();
      setSuggestions([]);
      setIsSearching(false);
      return;
    }

    const cacheKey = trimmed.toLowerCase();
    const cached = cacheRef.current.get(cacheKey);
    if (cached) {
      setSuggestions(cached);
      if (!selectionCommittedRef.current) setShowSuggestions(true);
      setIsSearching(false);
      return;
    }

    const cachedPrefix = Array.from(cacheRef.current.entries())
      .filter(([key]) => trimmed.toLowerCase().startsWith(key))
      .sort(([a], [b]) => b.length - a.length)[0]?.[1];

    if (cachedPrefix) {
      setSuggestions(cachedPrefix.filter(({ title }) =>
        title.toLowerCase().includes(trimmed.toLowerCase())
      ));
      if (!selectionCommittedRef.current) setShowSuggestions(true);
    }

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    requestControllerRef.current?.abort();
    const requestId = ++requestIdRef.current;
    setIsSearching(true);
    debounceRef.current = setTimeout(async () => {
      const controller = new AbortController();
      requestControllerRef.current = controller;

      try {
        const response = await fetch(
          `/api/wikipedia/search?q=${encodeURIComponent(trimmed)}`,
          { signal: controller.signal, headers: { Accept: 'application/json' } }
        );

        if (!response.ok) {
          if (response.status === 429 || response.status === 503) {
            if (requestId === requestIdRef.current) {
              setIsSearching(false);
              setSearchUnavailable(true);
            }
            return;
          }

          throw new Error(`Search failed: ${response.status}`);
        }

        const data = await response.json() as SearchResult[];
        if (requestId === requestIdRef.current) {
          cacheRef.current.set(cacheKey, data);
          setSuggestions(data);
          setIsSearching(false);
        }
      } catch (error) {
        if ((error as Error).name === 'AbortError') return;
        console.error('Search error:', error);
        if (requestId === requestIdRef.current) {
          setSuggestions([]);
          setIsSearching(false);
        }
      }
    }, 200);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      requestControllerRef.current?.abort();
    };
  }, [query]);

  const handleSelect = (title: string) => {
    selectionCommittedRef.current = true;
    setQuery(title);
    setShowSuggestions(false);
    setHighlightedIndex(-1);
    onSearch(title);
  };

  const resolveSubmission = () => {
    if (showBusyState) return;

    if (highlightedIndex >= 0) {
      if (showEmptyState) {
        handleSelect(trimmedQuery);
      } else if (suggestions[highlightedIndex]) {
        handleSelect(suggestions[highlightedIndex].title);
      }
      return;
    }
    if (!trimmedQuery) return;
    const exactMatch = suggestions.find(
      (suggestion) => suggestion.title.toLowerCase() === trimmedQuery.toLowerCase()
    );
    handleSelect(exactMatch ? exactMatch.title : trimmedQuery);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    resolveSubmission();
  };

  const getOptionId = (index: number) => `${listboxId}-option-${index}`;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!listVisible || showBusyState) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev + 1) % optionCount);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev <= 0 ? optionCount - 1 : prev - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setHighlightedIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setHighlightedIndex(optionCount - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      resolveSubmission();
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
      setHighlightedIndex(-1);
    }
  };

  return (
    <div className="seed-search relative">
      <form onSubmit={handleSubmit} className="seed-search-form">
        <div className="seed-search-field relative flex-1">
          {/* Search icon */}
          <div className="absolute left-4 top-1/2 -translate-y-1/2 text-cyan-400/60">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>

          <input
            ref={inputRef}
            id={`${listboxId}-input`}
            type="text"
            role="combobox"
            aria-label="Search Wikipedia articles"
            aria-expanded={listVisible}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={highlightedIndex >= 0 ? getOptionId(highlightedIndex) : undefined}
            value={query}
            onChange={(e) => {
              selectionCommittedRef.current = false;
              setQuery(e.target.value);
              setShowSuggestions(true);
              setHighlightedIndex(-1);
            }}
            onFocus={() => setShowSuggestions(true)}
            onBlur={(event) => {
              const nextTarget = event.relatedTarget;
              if (nextTarget instanceof HTMLElement && event.currentTarget.parentElement?.contains(nextTarget)) return;
              setShowSuggestions(false);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Search a Wikipedia article"
            className="seed-search-input w-full pl-12 pr-10 py-3.5 bg-slate-800/50 border border-white/10 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/50 focus:bg-slate-800/80 transition-all"
            disabled={isLoading}
          />

          {query && !isLoading && (
            <button
              type="button"
              aria-label="Clear search"
              className={`seed-search-clear ${isSearching ? 'is-searching' : ''}`}
              onClick={() => {
                setQuery('');
                setSuggestions([]);
                setShowSuggestions(false);
                inputRef.current?.focus();
              }}
            >
              <svg aria-hidden="true" viewBox="0 0 20 20" fill="none">
                <path d="m5 5 10 10M15 5 5 15" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
            </button>
          )}

          {isSearching && (
            <div
              aria-hidden="true"
              className="seed-search-spinner absolute right-4 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin rounded-full border-2 border-cyan-400 border-t-transparent"
            />
          )}
          <span className="sr-only" role="status" aria-live="polite">{isSearching ? 'Searching Wikipedia' : ''}</span>

          {/* Glow effect on focus */}
          <div className="absolute inset-0 rounded-xl bg-gradient-to-r from-cyan-500/10 via-purple-500/10 to-pink-500/10 opacity-0 focus-within:opacity-100 transition-opacity pointer-events-none" />

          {listVisible && (
            <ul
              id={listboxId}
              role="listbox"
              className="seed-search-list absolute z-50 w-full mt-2 glass-strong rounded-xl shadow-2xl overflow-hidden border border-white/10"
            >
              {showBusyState ? (
                <li role="presentation" className="px-4 py-3 text-sm text-slate-400">
                  <span role="status">Search is busy. Please try again shortly.</span>
                </li>
              ) : showEmptyState ? (
                <li>
                  <button
                    type="button"
                    id={getOptionId(0)}
                    role="option"
                    aria-selected={highlightedIndex === 0}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => handleSelect(trimmedQuery)}
                    className={`seed-search-option w-full px-4 py-3 text-left text-slate-300 hover:bg-white/5 transition-all ${
                      highlightedIndex === 0 ? 'bg-gradient-to-r from-cyan-500/20 to-purple-500/20 text-white' : ''
                    }`}
                  >
                    No article found. Search &quot;{trimmedQuery}&quot; anyway
                  </button>
                </li>
              ) : (
                suggestions.map((suggestion, index) => {
                  const isExact = suggestion.title.toLowerCase() === trimmedQuery.toLowerCase();
                  return (
                    <li key={suggestion.title}>
                      <button
                        type="button"
                        id={getOptionId(index)}
                        role="option"
                        aria-selected={index === highlightedIndex}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => handleSelect(suggestion.title)}
                        className={`seed-search-option w-full px-4 py-3 text-left text-white hover:bg-gradient-to-r hover:from-cyan-500/20 hover:to-purple-500/20 transition-all flex items-center gap-3 ${
                          index === highlightedIndex ? 'bg-gradient-to-r from-cyan-500/20 to-purple-500/20' : ''
                        }`}
                      >
                        <svg className="w-4 h-4 text-cyan-400/60 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        <span className="truncate">{suggestion.title}</span>
                        {isExact && (
                          <span className="ml-auto flex-shrink-0 text-[10px] uppercase tracking-wider text-slate-500">
                            Exact match
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
          )}
        </div>

        <button
          type="submit"
          disabled={isLoading || !query.trim()}
          aria-label="Explore article"
          className="seed-search-submit btn-primary px-8 py-3.5 text-white font-semibold rounded-xl flex items-center gap-2 shadow-lg shadow-cyan-500/20"
        >
          {isLoading ? (
            <>
              <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              <span>Mapping…</span>
            </>
          ) : (
            <>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              <span>Map topic</span>
            </>
          )}
        </button>
      </form>
    </div>
  );
}

