const text = (value) => String(value || '').toLowerCase();

const classify = (incident) => {
  const haystack = text([incident.title, incident.description, incident.reason].join(' '));
  if (/signal|weiche|gleis|infrastruktur|track|station/.test(haystack)) return 'infrastructure';
  if (/fahrzeug|vehicle|technical|technik|störung am zug/.test(haystack)) return 'vehicle';
  if (/polizei|security|notarzt|passag|medical|person/.test(haystack)) return 'passenger/security';
  if (/verkehr|betriebs|unregel|delay|verspät|stau/.test(haystack)) return 'operations/traffic';
  return 'unknown';
};

export const classifyDelayCauses = ({ line, issues = [], disruptions = [], reports = [] } = {}) => {
  const results = [];
  disruptions.filter((item) => item.lines?.includes(line)).forEach((incident) => results.push({
    cause: classify(incident), confidence: 82, source: 'official notice', evidence: incident.title,
  }));
  issues.filter((item) => item.line === line).forEach((issue) => results.push({
    cause: issue.type === 'gap' ? 'operations/traffic' : 'unknown', confidence: 48, source: 'inferred departures', evidence: `${issue.label} at ${issue.station}`,
  }));
  reports.filter((item) => !item.line || item.line === line).forEach((report) => results.push({
    cause: report.category === 'blocked_doors' ? 'passenger/security' : report.category === 'incident' ? 'unknown' : 'operations/traffic',
    confidence: 35, source: 'anonymous passenger report', evidence: report.note || report.category,
  }));
  return results.slice(0, 8);
};

export default classifyDelayCauses;
