/**
 * Formatting configuration derived from SpecsIntact .ini files.
 * See reference/section.ini, reference/document.ini for source data.
 *
 * Margins are in inches (from section.ini [MARGINS]).
 * Converted to pixels at ~96 DPI for screen rendering.
 */

// Raw margin data from section.ini [MARGINS]
// Format: { left: inches, right: inches, align: "LEFT"|"CENTER" }
export const MARGINS_INCHES = {
  CTR: { left: 0, right: 0, align: "CENTER" },
  DTE: { left: 0, right: 0, align: "CENTER" },
  DOC: { left: 1, right: 1 },
  HDR: { left: 0.13, right: 0.13 },
  HL4: { left: 0, right: 0, align: "CENTER" },
  ITM: { left: 0.85, right: 0 },
  LST: { left: 0.50, right: 0 },
  NTE: { left: 0.13, right: 0.13 },
  NPR: { left: 0.89, right: 0.89 },
  OAD: { left: 0.7, right: 0 },
  OLI: { left: 0.50, right: 0 },
  ORG: { left: 0.7, right: 0 },
  OTH: { left: 1, right: 1 },
  REF: { left: 0.16, right: 0 },
  RTL: { left: 2.7, right: 0 },
  SEC: { left: 1, right: 1 },
  SCN: { left: 0, right: 0, align: "CENTER" },
  STL: { left: 0, right: 0, align: "CENTER" },
  SPT: { left: 0, right: 0 },
  TXT: { left: 0.16, right: 0 },
  // TAB not in [MARGINS] - inherits from parent (TXT)
};

// Pixel margins for the editor (96 DPI approximation)
// These are absolute per block type, not cumulative with nesting depth
export const BLOCK_MARGINS = {
  txt: 15,    // TXT=0.16"
  note: 85,   // NPR=0.89"
  item: 82,   // ITM=0.85"
  lst: 48,    // LST=0.50"
  oli: 48,    // OLI=0.50"
};

// Color codes from section.ini [COLORS]
export const TAG_COLORS = {
  ADD: { fg: "GREEN", bg: "WHITE" },
  DEL: { fg: "LIGHTRED", bg: "WHITE" },
  ENG: { fg: "BLUE", bg: "WHITE" },
  HLS: { fg: "ORANGE", bg: "WHITE" },
  MET: { fg: "RED", bg: "WHITE" },
  RID: { fg: "LIGHTMAGENTA", bg: "WHITE" },
  SRF: { fg: "MAGENTA", bg: "WHITE" },
  SUB: { fg: "LIGHTBLUE", bg: "WHITE" },
  TAI: { fg: "CYAN", bg: "WHITE" },
  TST: { fg: "RED", bg: "WHITE" },
  URL: { fg: "YELLOW", bg: "WHITE" },
};

// Tag classifications from section.ini [CODES]
export const TRANSPARENT_TAGS = [
  'ADD', 'BLD', 'CHG', 'CTR', 'DEL', 'ENG',
  'HL1', 'HL2', 'HL3', 'HL4', 'HLS',
  'INC', 'ITA', 'MET', 'SBS', 'SPS',
  'TAI', 'TST', 'UND', 'URL'
];

// Nesting rules from section.ini [RULES]
export const NESTING_RULES = {
  TXT: ['PCDATA', 'ATT', 'RID', 'SRF', 'SUB', 'NED', 'PGE', 'TAB', 'TBL'],
  ITM: ['PCDATA', 'ATT', 'RID', 'SRF', 'SUB', 'NED', 'PGE', 'TAB', 'TBL'],
  OLI: ['PCDATA', 'ATT', 'RID', 'SRF', 'SUB', 'NED', 'PGE', 'TAB', 'TBL'],
  LST: ['PCDATA', 'ATT', 'RID', 'SRF', 'SUB', 'NED', 'PGE', 'TAB', 'TBL'],
  SUB: ['PCDATA', 'RID'],
  PRT: ['ATT', 'ITM', 'LST', 'NED', 'NTE', 'OLG', 'PGE', 'SBM', 'SPT', 'TTL', 'TXT'],
  SPT: ['ATT', 'ITM', 'LST', 'NED', 'NTE', 'OLG', 'PGE', 'REF', 'SBM', 'SPT', 'TAB', 'TBL', 'TTL', 'TXT'],
  SBM: ['ITM', 'LST', 'NTE', 'OLG', 'OLI', 'SPT', 'SUB', 'TXT'],
  REF: ['PGE', 'ORG', 'RID', 'RTL', 'NTE', 'OAD'],
};
