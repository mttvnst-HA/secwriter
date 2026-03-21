import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import umrlData from "../data/umrl.json";

/**
 * Reference Wizard — search the UMRL database to insert references.
 * Data: 302 organizations, 4,973 reference entries from UMRL.
 */

export default function RefWizard({ onAdd, onClose, existingOrgs }) {
  const [orgSearch, setOrgSearch] = useState('');
  const [selectedOrg, setSelectedOrg] = useState(null);
  const [refSearch, setRefSearch] = useState('');
  const [selectedRef, setSelectedRef] = useState(null);
  const searchRef = useRef(null);
  const refSearchRef = useRef(null);

  useEffect(() => { searchRef.current?.focus(); }, []);
  useEffect(() => { if (selectedOrg) setTimeout(() => refSearchRef.current?.focus(), 50); }, [selectedOrg]);

  // Extract abbreviation from org name: "ASTM INTERNATIONAL (ASTM)" → "ASTM"
  const getAbbr = (orgName) => {
    const m = orgName.match(/\(([^)]+)\)\s*$/);
    return m ? m[1] : orgName.split(/\s/)[0];
  };

  // All orgs sorted alphabetically
  const allOrgs = useMemo(() =>
    umrlData.map(o => ({ ...o, abbr: getAbbr(o.org) }))
      .sort((a, b) => a.org.localeCompare(b.org)),
  []);

  const filteredOrgs = useMemo(() => {
    if (!orgSearch) return allOrgs;
    const q = orgSearch.toLowerCase();
    return allOrgs.filter(o =>
      o.abbr.toLowerCase().includes(q) ||
      o.org.toLowerCase().includes(q)
    );
  }, [orgSearch, allOrgs]);

  // Filter references within selected org
  const filteredRefs = useMemo(() => {
    if (!selectedOrg) return [];
    const entries = selectedOrg.entries || [];
    if (!refSearch) return entries;
    const q = refSearch.toLowerCase();
    return entries.filter(e =>
      e.rid.toLowerCase().includes(q) ||
      e.rtl.toLowerCase().includes(q)
    );
  }, [selectedOrg, refSearch]);

  const handleAdd = useCallback(() => {
    if (!selectedOrg || !selectedRef) return;
    onAdd({
      org: selectedOrg.org,
      rid: selectedRef.rid,
      rtl: selectedRef.rtl,
    });
    setSelectedRef(null);
    setRefSearch('');
  }, [selectedOrg, selectedRef, onAdd]);

  const handleAddCustom = useCallback((rid, rtl) => {
    if (!selectedOrg || !rid) return;
    onAdd({ org: selectedOrg.org, rid, rtl });
  }, [selectedOrg, onAdd]);

  const panelStyle = {
    position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
    backgroundColor: 'white', borderRadius: 8, padding: 20,
    boxShadow: '0 8px 32px rgba(0,0,0,0.2)', zIndex: 200,
    width: 640, maxHeight: '85vh', display: 'flex', flexDirection: 'column',
  };

  const inputStyle = {
    width: '100%', border: '1px solid #cbd5e1', borderRadius: 4,
    padding: '6px 10px', fontSize: 13, outline: 'none', boxSizing: 'border-box',
  };

  const labelStyle = { fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 4 };

  return (
    <>
      <div onClick={onClose} style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.3)', zIndex: 199,
      }} />

      <div style={panelStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 16, color: '#1e293b' }}>Reference Wizard</h3>
          <span style={{ fontSize: 11, color: '#94a3b8' }}>UMRL — {umrlData.length} organizations, {umrlData.reduce((s, o) => s + o.entries.length, 0)} references</span>
          <button onClick={onClose} style={{
            border: 'none', background: 'transparent', fontSize: 18,
            color: '#94a3b8', cursor: 'pointer',
          }}>×</button>
        </div>

        {!selectedOrg ? (
          /* Step 1: Select Organization */
          <>
            <div style={labelStyle}>Search organizations:</div>
            <input
              ref={searchRef}
              type="text"
              value={orgSearch}
              onChange={(e) => setOrgSearch(e.target.value)}
              placeholder="Type organization name or abbreviation (e.g., ASTM, AASHTO)..."
              style={{ ...inputStyle, marginBottom: 8 }}
            />
            <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>
              {filteredOrgs.length} organization{filteredOrgs.length !== 1 ? 's' : ''}
              {existingOrgs?.length > 0 && ` (${existingOrgs.length} already in document)`}
            </div>
            <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: 4, maxHeight: 400 }}>
              {filteredOrgs.map((org, idx) => {
                const inDoc = existingOrgs?.includes(org.org);
                return (
                  <div
                    key={`${org.abbr}-${idx}`}
                    onClick={() => setSelectedOrg(org)}
                    style={{
                      padding: '6px 12px', cursor: 'pointer', fontSize: 13,
                      borderBottom: '1px solid #f1f5f9',
                      display: 'flex', gap: 8, alignItems: 'baseline',
                      backgroundColor: inDoc ? '#f0fdf4' : 'transparent',
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = inDoc ? '#dcfce7' : '#f1f5f9'}
                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = inDoc ? '#f0fdf4' : 'transparent'}
                  >
                    <span style={{ fontWeight: 700, color: '#1e40af', minWidth: 70, fontFamily: "'SF Mono', Consolas, monospace", fontSize: 12 }}>{org.abbr}</span>
                    <span style={{ color: '#475569', fontSize: 12, flex: 1 }}>{org.org}</span>
                    <span style={{ color: '#94a3b8', fontSize: 11 }}>{org.entries.length}</span>
                    {inDoc && <span style={{ color: '#16a34a', fontSize: 10, fontWeight: 600 }}>IN DOC</span>}
                  </div>
                );
              })}
              {filteredOrgs.length === 0 && (
                <div style={{ padding: 16, color: '#94a3b8', fontSize: 12, textAlign: 'center' }}>
                  No matching organizations found.
                </div>
              )}
            </div>
          </>
        ) : (
          /* Step 2: Select Reference within Organization */
          <>
            <div style={{
              padding: '6px 12px', backgroundColor: '#f1f5f9', borderRadius: 4,
              marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span style={{ fontWeight: 700, color: '#1e40af', fontFamily: "'SF Mono', Consolas, monospace" }}>{selectedOrg.abbr}</span>
              <span style={{ color: '#475569', fontSize: 12, flex: 1 }}>{selectedOrg.org}</span>
              <span style={{ color: '#94a3b8', fontSize: 11 }}>{selectedOrg.entries.length} references</span>
              <button onClick={() => { setSelectedOrg(null); setSelectedRef(null); setRefSearch(''); }} style={{
                border: 'none', background: 'transparent', color: '#3b82f6',
                cursor: 'pointer', fontSize: 12, fontWeight: 600,
              }}>Change</button>
            </div>

            <div style={labelStyle}>Search references:</div>
            <input
              ref={refSearchRef}
              type="text"
              value={refSearch}
              onChange={(e) => setRefSearch(e.target.value)}
              placeholder="Type designation or title (e.g., D2487, compaction)..."
              style={{ ...inputStyle, marginBottom: 4 }}
            />
            <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>
              {filteredRefs.length} reference{filteredRefs.length !== 1 ? 's' : ''}
            </div>

            <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: 4, maxHeight: 350 }}>
              {filteredRefs.map((entry) => {
                const isSelected = selectedRef?.rid === entry.rid;
                return (
                  <div
                    key={entry.rid}
                    onClick={() => setSelectedRef(entry)}
                    style={{
                      padding: '6px 12px', cursor: 'pointer', fontSize: 12,
                      borderBottom: '1px solid #f1f5f9',
                      display: 'flex', gap: 8, alignItems: 'baseline',
                      backgroundColor: isSelected ? '#eff6ff' : 'transparent',
                      borderLeft: isSelected ? '3px solid #3b82f6' : '3px solid transparent',
                    }}
                    onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.backgroundColor = '#f1f5f9'; }}
                    onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent'; }}
                  >
                    <span style={{
                      fontWeight: 600, color: '#1e40af', minWidth: 120,
                      fontFamily: "'SF Mono', Consolas, monospace", fontSize: 12,
                      flexShrink: 0,
                    }}>{entry.rid}</span>
                    <span style={{ color: '#475569', fontSize: 12 }}>{entry.rtl}</span>
                  </div>
                );
              })}
              {filteredRefs.length === 0 && refSearch && (
                <div style={{ padding: 16, color: '#94a3b8', fontSize: 12, textAlign: 'center' }}>
                  No matching references. You can add a custom entry below.
                </div>
              )}
            </div>

            {/* Selected reference preview + Add button */}
            {selectedRef && (
              <div style={{
                marginTop: 8, padding: '8px 12px', backgroundColor: '#eff6ff',
                borderRadius: 4, border: '1px solid #bfdbfe',
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <div style={{ flex: 1 }}>
                  <span style={{ fontWeight: 700, color: '#1e40af', fontFamily: "'SF Mono', Consolas, monospace", fontSize: 13 }}>
                    {selectedRef.rid}
                  </span>
                  <span style={{ color: '#475569', fontSize: 12, marginLeft: 8 }}>{selectedRef.rtl}</span>
                </div>
                <button onClick={handleAdd} style={{
                  padding: '6px 16px', border: 'none', borderRadius: 4,
                  backgroundColor: '#2563eb', color: 'white', fontSize: 13,
                  cursor: 'pointer', fontWeight: 600, flexShrink: 0,
                }}>Add Reference</button>
              </div>
            )}

            {/* Custom entry option */}
            {!selectedRef && refSearch && filteredRefs.length === 0 && (
              <CustomRefEntry abbr={selectedOrg.abbr} onAdd={handleAddCustom} />
            )}
          </>
        )}
      </div>
    </>
  );
}

/** Inline custom reference entry form (when UMRL doesn't have the reference) */
function CustomRefEntry({ abbr, onAdd }) {
  const [rid, setRid] = useState('');
  const [rtl, setRtl] = useState('');
  return (
    <div style={{
      marginTop: 8, padding: '8px 12px', backgroundColor: '#fffbeb',
      borderRadius: 4, border: '1px solid #fde68a',
    }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#92400e', marginBottom: 6 }}>
        Custom reference (not in UMRL):
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ fontWeight: 700, color: '#1e40af', fontSize: 13 }}>{abbr}</span>
        <input
          type="text" value={rid} onChange={(e) => setRid(e.target.value)}
          placeholder="Designation" autoFocus
          style={{ width: 120, border: '1px solid #cbd5e1', borderRadius: 4, padding: '4px 8px', fontSize: 12, outline: 'none' }}
        />
        <input
          type="text" value={rtl} onChange={(e) => setRtl(e.target.value)}
          placeholder="(Year) Title..."
          onKeyDown={(e) => { if (e.key === 'Enter' && rid) onAdd(`${abbr} ${rid}`, rtl); }}
          style={{ flex: 1, border: '1px solid #cbd5e1', borderRadius: 4, padding: '4px 8px', fontSize: 12, outline: 'none' }}
        />
        <button
          onClick={() => { if (rid) onAdd(`${abbr} ${rid}`, rtl); }}
          disabled={!rid}
          style={{
            padding: '4px 12px', border: 'none', borderRadius: 4,
            backgroundColor: rid ? '#2563eb' : '#94a3b8', color: 'white',
            fontSize: 12, cursor: rid ? 'pointer' : 'default', fontWeight: 600,
          }}
        >Add</button>
      </div>
    </div>
  );
}
