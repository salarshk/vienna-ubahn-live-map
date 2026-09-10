import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Search, X, MapPin, Navigation } from 'lucide-react';
import metroData from '../data/metro_lines.json';
import gtfsData from '../data/gtfs_expanded.json';
import sbahnData from '../data/sbahn_network.json';

// gtfs_expanded.json is the canonical station set for the whole network; the
// handful of points in metro_lines.json are a much older subset.
const stationByKey = new Map();
for (const station of [
  ...gtfsData.features.filter(f => f.geometry.type === 'Point'),
  ...sbahnData.features.filter(f => f.geometry.type === 'Point'),
]) {
  const key = station.properties.apiId || station.properties.name;
  const existing = stationByKey.get(key);
  if (existing) {
    existing.properties.lines = [...new Set([
      ...(existing.properties.lines || []), ...(station.properties.lines || []),
    ])];
  } else {
    stationByKey.set(key, {
      ...station,
      properties: { ...station.properties, lines: [...(station.properties.lines || [])] },
    });
  }
}
const stations = [...stationByKey.values()];
const lines = [
  ...metroData.features.filter(f => f.geometry.type === 'LineString'),
  ...sbahnData.features.filter(f => f.geometry.type === 'LineString'),
];

const SearchBar = ({ onSelectStation, onSelectLine, activeLineFilter }) => {
  const [query,       setQuery]       = useState('');
  const [isOpen,      setIsOpen]      = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const dropdownRef = useRef(null);
  const inputRef    = useRef(null);

  // Filtered results
  const filteredLines = query.trim()
    ? lines.filter(l =>
        l.properties.name.toLowerCase().includes(query.toLowerCase()) ||
        l.properties.line.includes(query)
      )
    : [];

  const filteredStations = query.trim()
    ? stations.filter(st =>
        st.properties.name.toLowerCase().includes(query.toLowerCase())
      )
    : [];

  // Flat ordered list of all results for keyboard nav
  const allItems = [
    ...filteredLines.map(l  => ({ type: 'line',    data: l  })),
    ...filteredStations.map(st => ({ type: 'station', data: st })),
  ];

  // Close on outside click
  useEffect(() => {
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setIsOpen(false);
        setHighlighted(-1);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleSelectStation = useCallback((st) => {
    onSelectStation(st);
    setQuery(st.properties.name);
    setIsOpen(false);
    setHighlighted(-1);
  }, [onSelectStation]);

  const handleSelectLine = useCallback((line) => {
    onSelectLine(line.properties.line);
    setQuery(line.properties.line);
    setIsOpen(false);
    setHighlighted(-1);
  }, [onSelectLine]);

  const handleClear = () => {
    setQuery('');
    setIsOpen(false);
    setHighlighted(-1);
    if (activeLineFilter) onSelectLine(null);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e) => {
    if (!isOpen || allItems.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted(h => Math.min(h + 1, allItems.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted(h => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlighted >= 0 && highlighted < allItems.length) {
        const item = allItems[highlighted];
        if (item.type === 'station') handleSelectStation(item.data);
        else handleSelectLine(item.data);
      }
    } else if (e.key === 'Escape') {
      setIsOpen(false);
      setHighlighted(-1);
    }
  };

  let itemIdx = 0; // Running counter for keyboard highlight mapping

  return (
    <div ref={dropdownRef} style={{ position: 'relative', width: '100%' }}>
      {/* Input row */}
      <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: '8px' }}>
        <Search size={18} color="var(--text-secondary)" style={{ flexShrink: 0 }} />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={e => { setQuery(e.target.value); setIsOpen(true); setHighlighted(-1); }}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="Search Vienna stations and lines..."
          aria-label="Search stations and lines"
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--text-primary)',
            fontSize: '0.93rem',
            width: '100%',
            outline: 'none',
          }}
        />
        {query && (
          <button
            onClick={handleClear}
            style={{ padding: '4px', borderRadius: '50%', background: 'var(--bg-hover)', display: 'flex', flexShrink: 0 }}
            title="Clear search"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Dropdown */}
      {isOpen && allItems.length > 0 && (
        <div
          className="glass-panel"
          style={{
            position: 'absolute',
            top: 'calc(100% + 10px)',
            left: 0,
            right: 0,
            maxHeight: '320px',
            overflowY: 'auto',
            zIndex: 200,
            padding: '6px 0',
            background: 'var(--bg-panel-solid)',
            boxShadow: '0 12px 32px rgba(0,0,0,0.4)',
          }}
          role="listbox"
        >
          {/* Lines section */}
          {filteredLines.length > 0 && (
            <div style={{ padding: '4px 0' }}>
              <div style={{ padding: '2px 14px 4px', fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--text-secondary)' }}>
                Lines
              </div>
              {filteredLines.map((line) => {
                const idx = itemIdx++;
                const isHl = highlighted === idx;
                return (
                  <div
                    key={`line-${line.properties.line}`}
                    role="option"
                    aria-selected={isHl}
                    onClick={() => handleSelectLine(line)}
                    onMouseEnter={() => setHighlighted(idx)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      padding: '8px 14px',
                      cursor: 'pointer',
                      background: isHl ? 'var(--bg-hover)' : 'transparent',
                      transition: 'background 0.1s',
                    }}
                  >
                    <div style={{
                      width: '22px', height: '22px', borderRadius: '50%',
                      background: line.properties.color, color: '#fff',
                      fontWeight: 800, fontSize: '10px',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      flexShrink: 0,
                    }}>
                      {line.properties.line}
                    </div>
                    <span style={{ fontSize: '0.88rem', fontWeight: 500 }}>{line.properties.name}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Stations section */}
          {filteredStations.length > 0 && (
            <div style={{ padding: '4px 0' }}>
              {filteredLines.length > 0 && (
                <div style={{ height: '1px', background: 'var(--border-color)', margin: '2px 14px 6px' }} />
              )}
              <div style={{ padding: '2px 14px 4px', fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--text-secondary)' }}>
                Stations
              </div>
              {filteredStations.map((st) => {
                const idx = itemIdx++;
                const isHl = highlighted === idx;
                return (
                  <div
                    key={`st-${st.properties.name}`}
                    role="option"
                    aria-selected={isHl}
                    onClick={() => handleSelectStation(st)}
                    onMouseEnter={() => setHighlighted(idx)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      padding: '8px 14px',
                      cursor: 'pointer',
                      background: isHl ? 'var(--bg-hover)' : 'transparent',
                      transition: 'background 0.1s',
                    }}
                  >
                    <MapPin size={14} color="var(--text-secondary)" style={{ flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '0.88rem', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {st.properties.name}
                      </div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                        Lines: {(st.properties.lines || []).join(', ')}
                      </div>
                    </div>
                    <Navigation size={12} color="var(--text-secondary)" style={{ flexShrink: 0 }} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default SearchBar;
