import React from 'react';
import { ChevronLeft, Check, Eye, EyeOff } from 'lucide-react';
import metroData from '../data/metro_lines.json';
import gtfsData from '../data/gtfs_expanded.json';
import sbahnData from '../data/sbahn_network.json';
import tramData from '../data/tram_network.json';
import { getSbahnFreshness } from '../services/dataFreshness';
import ServiceAlerts from './ServiceAlerts';

const Sidebar = ({
  isOpen,
  onToggleSidebar,
  activeLineFilter,
  onSelectLine,
  onHoverLine,
  trainStats = { live: 0, confirmed: 0, scheduled: 0 },
  mapVisibility = { ubahnLines: true, sbahnLines: true, tramLines: false, liveTrains: true, tramTrains: false, scheduledTrains: true, confidenceRanges: true, movementTrails: true, reliabilityAtlas: false, cellGrid: false },
  onToggleVisibility,
  disruptionSnapshot,
  selectedAlert,
  onSelectAlert,
  onRefreshAlerts,
  alertsOpen,
  onAlertsOpenChange,
  onOpenAlerts,
}) => {
  // Combine line features from bundled metro JSON and GTFS-generated data.
  const allFeatures = [
    ...metroData.features,
    ...(gtfsData && gtfsData.features ? gtfsData.features : []),
    ...(sbahnData.features || []),
    ...(tramData.features || []),
  ];
  const lineFeatures = allFeatures.filter(f => f.geometry && f.geometry.type === 'LineString');
  const seen = new Set();
  const lines = [];
  for (const f of lineFeatures) {
    const id = f.properties && f.properties.line;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    lines.push({ properties: { line: id, mode: f.properties?.mode || 'ubahn', color: f.properties && f.properties.color ? f.properties.color : '#888', name: f.properties && f.properties.name ? f.properties.name : `Line ${id}` } });
  }
  const freshness = getSbahnFreshness();
  const visibilityControls = [
    ['ubahnLines', 'U-Bahn lines'],
    ['sbahnLines', 'S-Bahn lines'],
    ['tramLines', 'Tram lines (optional)'],
    ['liveTrains', 'U-Bahn trains'],
    ['tramTrains', 'Live trams'],
    ['scheduledTrains', 'Scheduled S-Bahn'],
    ['confidenceRanges', 'Position ranges'],
    ['movementTrails', 'Selected train trail'],
    ['reliabilityAtlas', 'Reliability atlas'],
    ['cellGrid', '200 m Vienna intelligence grid'],
  ];

  return (
    <>
      {/* Sidebar Container */}
      <div 
        className={`sidebar glass-panel ${!isOpen ? 'collapsed' : ''}`} 
        style={{ padding: '20px' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{
              width: '36px', height: '36px', borderRadius: '10px',
              background: 'linear-gradient(135deg, #FFD100 0%, #E2001A 100%)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontWeight: 800, color: '#fff', fontSize: '1.1rem'
            }}>
              V
            </div>
            <div>
              <h1 style={{ fontSize: '1.1rem', fontWeight: 700, letterSpacing: '-0.3px' }}>Vienna Rail</h1>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>U-Bahn live timing · predicted position · S-Bahn timetable</div>
            </div>
          </div>

          <button 
            onClick={onToggleSidebar}
            style={{ 
              padding: '6px', 
              borderRadius: '8px', 
              background: 'var(--bg-hover)',
              display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}
            title={isOpen ? "Collapse Sidebar" : "Expand Sidebar"}
          >
            <ChevronLeft size={20} />
          </button>
        </div>

        <div className="sidebar-scroll" style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div>
            <h2 style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-secondary)', marginBottom: '10px' }}>
              Map layers
            </h2>
            <div className="layer-control-grid">
              {visibilityControls.map(([key, label]) => {
                const visible = mapVisibility[key];
                return (
                  <button
                    key={key}
                    className="layer-control-button"
                    aria-pressed={visible}
                    onClick={() => onToggleVisibility(key)}
                  >
                    {visible ? <Eye size={15} /> : <EyeOff size={15} />}
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>
            <div className="marker-legend" aria-label="Train marker legend">
              <span><i className="legend-marker live" />Live timing, predicted position</span>
              <span><i className="legend-marker scheduled" />Scheduled</span>
              <span><i className="legend-marker simulated" />Fallback</span>
            </div>
            <p style={{ margin: '8px 2px 0', fontSize: '0.72rem', lineHeight: 1.4, color: 'var(--text-secondary)' }}>
              Trams are optional to keep the city view clear. Their timing is live when the Wiener Linien monitor reports it; map positions remain departure-based unless the feed provides coordinates.
            </p>
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <h2 style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-secondary)' }}>
                Lines & Services
              </h2>
              {Array.isArray(activeLineFilter) && activeLineFilter.length > 0 && (
                <button 
                  onClick={() => onSelectLine(null)}
                  style={{ fontSize: '0.75rem', color: '#FFD100', textDecoration: 'underline' }}
                >
                  Show All
                </button>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {lines.map((line) => {
                const lineId = line.properties.line;
                const isSelected = Array.isArray(activeLineFilter) && activeLineFilter.includes(lineId);

                return (
                  <div
                    key={lineId}
                    onClick={() => onSelectLine(lineId)}
                    onMouseEnter={() => onHoverLine && onHoverLine(lineId)}
                    onMouseLeave={() => onHoverLine && onHoverLine(null)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      padding: '10px 12px',
                      borderRadius: '10px',
                      background: isSelected ? 'var(--bg-hover-active)' : 'var(--bg-hover)',
                      border: isSelected ? `1.5px solid ${line.properties.color}` : '1.5px solid transparent',
                      cursor: 'pointer',
                      transition: 'all 0.2s ease'
                    }}
                    className="line-card-hover"
                  >
                    <div style={{
                      width: '32px', height: '32px',
                      borderRadius: '50%',
                      background: line.properties.color,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: '#fff', fontWeight: 'bold', fontSize: '0.95rem',
                      boxShadow: `0 0 10px ${line.properties.color}44`
                    }}>
                      {lineId}
                    </div>

                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: '0.88rem' }}>{line.properties.name}</div>
                      <div style={{ fontSize: '0.75rem', color: line.properties.mode === 'sbahn' ? '#00B4D8' : '#4CAF50', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: line.properties.mode === 'sbahn' ? '#00B4D8' : '#4CAF50' }}></span>
                        {line.properties.mode === 'sbahn' ? 'Scheduled positions' : 'Live departures'}
                      </div>
                    </div>

                    {isSelected && (
                      <div style={{
                        width: '20px', height: '20px', borderRadius: '50%',
                        background: line.properties.color, color: '#fff',
                        display: 'flex', alignItems: 'center', justifyContent: 'center'
                      }}>
                        <Check size={12} strokeWidth={3} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <ServiceAlerts
            snapshot={disruptionSnapshot}
            selectedAlert={selectedAlert}
            onSelectAlert={onSelectAlert}
            onRefresh={onRefreshAlerts}
            sidebarOpen={isOpen}
            isOpen={alertsOpen}
            onOpenChange={onAlertsOpenChange}
            onOpen={onOpenAlerts}
            embedded
          />

          {/* Live Stats & Footer */}
          <div style={{ marginTop: 'auto', paddingTop: '16px', borderTop: '1px solid var(--border-color)' }}>
            <h2 style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-secondary)', marginBottom: '10px' }}>
              Rail Network
            </h2>
            <div style={{ display: 'flex', gap: '8px' }}>
              <div style={{
                flex: 1, padding: '10px 12px', borderRadius: '10px',
                background: 'var(--bg-hover)', textAlign: 'center',
              }}>
                <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#4CAF50', lineHeight: 1 }}>
                  {trainStats.live}
                </div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
                  Live trains
                </div>
              </div>
              <div style={{
                flex: 1, padding: '10px 12px', borderRadius: '10px',
                background: 'var(--bg-hover)', textAlign: 'center',
              }}>
                <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#FFD100', lineHeight: 1 }}>
                  {trainStats.scheduled}
                </div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
                  Scheduled S-Bahn
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '8px', lineHeight: 1.5 }}>
              <span>📍 {trainStats.confirmed} U-Bahn confirmed · ÖBB S-Bahn</span>
              <span style={{ opacity: 0.6, fontVariantNumeric: 'tabular-nums' }}>v{__APP_VERSION__}</span>
            </div>
            <div className={`data-freshness ${freshness.status}`}>
              <span className="data-freshness-dot" />
              {freshness.message}
            </div>
          </div>

        </div>
      </div>
    </>
  );
};

export default Sidebar;
