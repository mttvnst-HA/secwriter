/**
 * TAI Tailoring Profile Logic
 *
 * Handles matching TAI OPT values against a user's tailoring profile
 * (service branch, region, delivery method) and resolving TAI content
 * visibility in editor HTML.
 */

// Service branches
export const BRANCHES = ['ARMY', 'NAVY', 'AIR FORCE'];

// Delivery methods
export const DELIVERY_METHODS = ['DESIGN-BUILD', 'DESIGN-BID-BUILD'];

// NAVFAC regions (visible when branch = NAVY)
export const REGIONS = [
  'NAVFAC',
  'NAVFAC EURAFCENT',
  'NAVFAC FE',
  'NAVFAC HAWAII',
  'NAVFAC HI',
  'NAVFAC LANT',
  'NAVFAC MAR',
  'NAVFAC MARIANAS',
  'NAVFAC ML',
  'NAVFAC NW',
  'NAVFAC PAC',
  'NAVFAC SE',
  'NAVFAC SW',
  'NAVFAC WASH',
];

/**
 * Check if a single OPT token matches the active profile.
 *
 * Match rules:
 * - Direct branch match: "ARMY" matches { branch: "ARMY" }
 * - Delivery method match: "DESIGN-BUILD" matches { deliveryMethod: "DESIGN-BUILD" }
 * - Compound branch+delivery: "ARMY DESIGN-BUILD" matches both branch AND delivery
 * - Region match: "NAVFAC NW" matches { region: "NAVFAC NW" } (requires NAVY branch)
 * - Multi-branch: "ARMY/AIR FORCE" matches either branch
 * - Negation: "NON-ARMY" / "NOT-ARMY" matches when branch is NOT ARMY
 * - "NAVY WITH ACCEPTANCE ENGINEER" → treated as NAVY variant
 *
 * @param {string} token - Single OPT value (trimmed)
 * @param {Object} profile - { branch, region, deliveryMethod }
 * @returns {boolean}
 */
function tokenMatchesProfile(token, profile) {
  const t = token.toUpperCase().trim();
  const { branch, region, deliveryMethod } = profile;

  if (!t) return false;

  // Negation patterns
  if (t === 'NON-ARMY' || t === 'NOT-ARMY') {
    return branch && branch !== 'ARMY';
  }

  // Multi-branch with slash: "ARMY/AIR FORCE"
  if (t.includes('/')) {
    const parts = t.split('/').map(s => s.trim());
    return parts.some(p => p === branch);
  }

  // Compound branch + delivery: "ARMY DESIGN-BUILD", "NAVY DESIGN-BUILD"
  for (const dm of DELIVERY_METHODS) {
    for (const br of BRANCHES) {
      if (t === `${br} ${dm}`) {
        return branch === br && deliveryMethod === dm;
      }
    }
  }

  // Direct branch match
  if (BRANCHES.includes(t)) {
    return t === branch;
  }

  // Direct delivery method match
  if (DELIVERY_METHODS.includes(t)) {
    return t === deliveryMethod;
  }

  // Region match (NAVFAC variants) — requires NAVY branch
  if (t.startsWith('NAVFAC')) {
    if (branch !== 'NAVY') return false;
    // Exact region match or general NAVFAC matches any NAVY
    if (t === 'NAVFAC') return true;
    return t === region;
  }

  // NAVY variant tokens
  if (t.startsWith('NAVY ')) {
    return branch === 'NAVY';
  }

  // No match for unrecognized tokens (non-branch/region/delivery tokens
  // like "ALUMINUM" or "BACNET" are project-specific and always included
  // when no matching rule applies)
  return true;
}

/**
 * Check if an OPT string (possibly comma-separated) matches the profile.
 * Returns true if ANY value matches.
 *
 * @param {string} optString - Comma-separated OPT values
 * @param {Object} profile - { branch, region, deliveryMethod }
 * @returns {boolean}
 */
export function doesOptMatch(optString, profile) {
  if (!optString || !profile.branch) return true;

  const tokens = optString.split(',').map(s => s.trim()).filter(Boolean);
  if (tokens.length === 0) return true;

  return tokens.some(token => tokenMatchesProfile(token, profile));
}

/**
 * Apply tailoring resolution classes to HTML containing TAI spans.
 *
 * - Matched: adds `tai-included` class (renders normally)
 * - Unmatched + !showAll: adds `tai-excluded` class (hidden via CSS)
 * - Unmatched + showAll: adds `tai-excluded-visible` class (dimmed)
 *
 * @param {string} html - Block HTML with mark-tai spans
 * @param {Object} profile - { branch, region, deliveryMethod }
 * @param {boolean} showAll - If true, show excluded content as dimmed
 * @returns {string} HTML with resolution classes added
 */
export function resolveTaiInHtml(html, profile, showAll = false) {
  if (!html || !profile.branch) return html;

  // Match TAI spans with optional data-opt
  return html.replace(
    /<span\s+class="mark-tai(?:\s+tai-\w+(?:-\w+)*)?"(\s+data-opt="([^"]*)")?>/g,
    (match, optGroup, optValue) => {
      const included = doesOptMatch(optValue || '', profile);
      const cls = included
        ? 'mark-tai tai-included'
        : showAll
          ? 'mark-tai tai-excluded-visible'
          : 'mark-tai tai-excluded';
      const optAttr = optValue ? ` data-opt="${optValue}"` : '';
      return `<span class="${cls}"${optAttr}>`;
    }
  );
}

/**
 * Strip TAI resolution classes from HTML, restoring clean mark-tai.
 * Used in handleBlur to prevent resolution state from polluting stored data.
 *
 * @param {string} html - HTML that may contain tai-included/excluded classes
 * @returns {string} Cleaned HTML
 */
export function cleanTaiClasses(html) {
  if (!html) return html;
  return html.replace(
    /\bmark-tai\s+tai-(?:excluded-visible|excluded|included)\b/g,
    'mark-tai'
  );
}
