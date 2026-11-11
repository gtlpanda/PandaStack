/** Historical credit is usable only when the entire selected backlog is valid. */
function historicalPassingIds(source) {
  if (typeof source !== 'string') return null;
  let doc;
  try { doc = JSON.parse(source); }
  catch { return null; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.features)) return null;

  const ids = new Set();
  const passing = new Set();
  for (const feature of doc.features) {
    if (!feature || typeof feature !== 'object' || Array.isArray(feature)
      || typeof feature.id !== 'string' || feature.id.length === 0
      || typeof feature.passes !== 'boolean' || ids.has(feature.id)) return null;
    ids.add(feature.id);
    if (feature.passes) passing.add(feature.id);
  }
  return passing;
}

/** Missing or malformed history cannot establish that current passing work was reviewed. */
export function countUnreviewed(features, historicalSource) {
  const before = historicalPassingIds(historicalSource);
  // Keep the current backlog's existing truthy passing and per-row counting semantics.
  return features.filter(feature => feature.passes && (!before || !before.has(feature.id))).length;
}
