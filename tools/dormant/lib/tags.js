// Tag merging + confidence rules shared by build-snapshot.js and tests.
// Provenance-first: a tag without sources is 'unverified', one source is
// 'single-source', two or more independent sources are 'corroborated'.
'use strict';

const sourceKey = (s) => (s && (s.url || s.name)) || '';

// tags: [{label, category, confidence, sources: [{name, url, retrievedAt}]}]
const mergeTags = (tags) => {
  const byLabel = new Map();
  for (const tag of tags || []) {
    const key = (tag.label || '').toLowerCase();
    if (!key) continue;
    const existing = byLabel.get(key);
    if (!existing) {
      byLabel.set(key, {
        label: tag.label,
        category: tag.category || 'unknown',
        sources: [...(tag.sources || [])],
      });
      continue;
    }
    if (existing.category === 'unknown' && tag.category) existing.category = tag.category;
    const seen = new Set(existing.sources.map(sourceKey));
    for (const s of tag.sources || []) {
      const k = sourceKey(s);
      if (k && !seen.has(k)) {
        existing.sources.push(s);
        seen.add(k);
      }
    }
  }
  const merged = [];
  for (const t of byLabel.values()) {
    const distinct = new Set(t.sources.map(sourceKey).filter(Boolean));
    let confidence;
    if (distinct.size >= 2) confidence = 'corroborated';
    else if (distinct.size === 1) confidence = 'single-source';
    else confidence = 'unverified';
    merged.push({ label: t.label, category: t.category, confidence, sources: t.sources });
  }
  merged.sort((a, b) => a.label.localeCompare(b.label));
  return merged;
};

const isDormant = (lastActiveMs, nowMs, years) =>
  lastActiveMs > 0 && nowMs - lastActiveMs >= years * 365.25 * 24 * 3600 * 1000;

module.exports = { mergeTags, isDormant, sourceKey };
