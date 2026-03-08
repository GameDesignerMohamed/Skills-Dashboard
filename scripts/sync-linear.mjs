#!/usr/bin/env node
/**
 * Fetches all Mind Skills issues from Linear and regenerates index.html
 * Usage: LINEAR_API_KEY=xxx node scripts/sync-linear.mjs
 */

const LINEAR_API = 'https://api.linear.app/graphql';
const TEAM_NAME = 'Mind Skills';
const KNOWN_MINDS = ['Flux', 'Helix-Synth', 'Sparks', 'Glyf', 'AB', 'Ratchet'];
const PIPELINE_STATUSES = ['Testing', 'Mind Verified', 'Uploading', 'Needs Attention', 'Human Verified'];

const API_KEY = process.env.LINEAR_API_KEY;
if (!API_KEY) { console.error('LINEAR_API_KEY env var required'); process.exit(1); }

// ── Fetch all issues with pagination ──
async function fetchAllIssues() {
  let allIssues = [];
  let hasMore = true;
  let cursor = null;

  while (hasMore) {
    const afterClause = cursor ? `, after: "${cursor}"` : '';
    const query = `{
      issues(
        filter: {
          team: { name: { eq: "${TEAM_NAME}" } }
          project: { name: { eq: "Skills Repository" } }
        }
        first: 250
        ${afterClause}
        orderBy: updatedAt
      ) {
        nodes {
          identifier
          title
          createdAt
          archivedAt
          state { name type }
          labels { nodes { name } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`;

    const res = await fetch(LINEAR_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': API_KEY },
      body: JSON.stringify({ query }),
    });
    const json = await res.json();
    if (json.errors) { console.error('Linear API error:', json.errors); process.exit(1); }

    const { nodes, pageInfo } = json.data.issues;
    allIssues.push(...nodes);
    hasMore = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor;
  }

  return allIssues.filter(i => !i.archivedAt);
}

// ── Clean title: strip UUIDs, artifact IDs, offering prefixes ──
function cleanTitle(title) {
  let t = title;
  // Remove [UUID] or [ARTIFACT-ID] at start or end
  t = t.replace(/^\[[^\]]{8,}\]\s*/i, '');
  t = t.replace(/\s*\[[^\]]{8,}\]$/i, '');
  // Remove (UUID) at end
  t = t.replace(/\s*\([A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}\)\s*$/i, '');
  // Remove "Xxx Offering NN — " prefix
  t = t.replace(/^[\w-]+\s+Offering\s+\d+\s*[—–-]\s*/i, '');
  // Trim
  return t.trim();
}

// ── Extract Mind from labels ──
function extractMind(labels) {
  const names = labels.nodes.map(l => l.name);
  return names.find(n => KNOWN_MINDS.includes(n)) || '—';
}

// ── Format date ──
function fmtDate(iso) {
  const d = new Date(iso);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `${months[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2,'0')}, ${d.getUTCFullYear()}`;
}
function shortDate(iso) { return iso.slice(0, 10).slice(5); }

// ── Build time series: count issues updated per day (last 7 days) ──
function buildTimeSeries(issues) {
  const now = new Date();
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const counts = {};
  days.forEach(d => counts[d] = 0);
  issues.forEach(s => {
    const created = s.createdAt.slice(0, 10);
    if (counts[created] !== undefined) counts[created]++;
  });
  return days.map(d => ({
    label: d.slice(5).replace('-', '/').replace(/^0/, '').toUpperCase()
      .replace(/(\d+)\/(\d+)/, (_, m, day) => {
        const months = ['','JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
        return `${months[+m]} ${day}`;
      }),
    count: counts[d],
  }));
}

// ── Generate HTML ──
function generateHTML(skills, kpis, timeSeries, today) {
  const maxBar = Math.max(...timeSeries.map(t => t.count), 1);

  const timeBarHTML = timeSeries.map(t => {
    const pct = Math.round((t.count / maxBar) * 100);
    return `      <div class="time-bar-group">
        <div class="time-bar-wrapper">
          <div class="time-bar" style="height: ${pct}%; background: linear-gradient(to top, rgba(16,172,235,0.3), var(--blue));">
            <div class="time-bar-value">${t.count}</div>
          </div>
        </div>
        <div class="time-label">${t.label}</div>
      </div>`;
  }).join('\n');

  const rowsHTML = skills.map(s => `          <tr data-status="${s.status}" data-name="${s.name.toLowerCase()}">
            <td class="col-id">${s.id}</td>
            <td class="col-name">${s.name}</td>
            <td><span class="status-badge ${s.statusClass}">${s.status}</span></td>
            <td><span class="mind-tag">${s.mind}</span></td>
            <td class="col-date">${s.date}</td>
          </tr>`).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Minds Skills Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --black: #131112;
    --white: #F5F5F3;
    --blue: #10ACEB;
    --muted: #A69080;
    --charcoal: #333333;
    --surface: #131112;
    --surface-raised: #1D1A1B;
    --surface-hover: #252223;
    --border: #302E2F;
    --border-subtle: #1F1E1D;
    --blue-dim: rgba(16, 172, 235, 0.08);
    --blue-glow: rgba(16, 172, 235, 0.15);
    --green: #4AE8A0;
    --amber: #E8C44A;
    --red: #F15738;
    --purple: #A07DE8;
    --body-text: #C5C5C3;
    --font-mono: 'Space Mono', monospace;
    --font-body: 'Inter', -apple-system, sans-serif;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    background: var(--surface);
    color: var(--white);
    font-family: var(--font-body);
    min-height: 100dvh;
    overflow-x: hidden;
  }

  body::before {
    content: '';
    position: fixed;
    inset: 0;
    opacity: 0.025;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
    pointer-events: none;
    z-index: 9999;
  }

  .header {
    padding: 48px 48px 0;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
  }
  .header-left { display: flex; flex-direction: column; gap: 8px; }
  .header-badge {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 3px;
    text-transform: uppercase;
    color: var(--blue);
    opacity: 0.8;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .header-badge::before {
    content: '';
    width: 6px; height: 6px;
    background: var(--blue);
    border-radius: 50%;
    animation: pulse-dot 2s ease-in-out infinite;
  }
  @keyframes pulse-dot {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.4; transform: scale(0.8); }
  }
  .header h1 {
    font-family: var(--font-mono);
    font-size: 32px;
    font-weight: 700;
    color: var(--white);
    line-height: 1.1;
  }
  .header h1 span { color: var(--blue); }
  .header-right {
    text-align: right;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
  }
  .header-date {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--muted);
    letter-spacing: 1px;
  }
  .header-total {
    font-family: var(--font-mono);
    font-size: 48px;
    font-weight: 700;
    color: var(--white);
    line-height: 1;
  }
  .header-total-label {
    font-family: var(--font-body);
    font-size: 14px;
    color: var(--muted);
  }

  .dashboard {
    padding: 36px 48px 48px;
    display: grid;
    grid-template-columns: 1fr 1fr 1fr 1fr;
    grid-template-rows: auto auto auto;
    gap: 16px;
  }

  .card {
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: 12px;
    padding: 24px;
    position: relative;
    overflow: hidden;
    transition: border-color 0.2s ease;
  }
  .card:hover { border-color: var(--border); }
  .card-label {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .card-label svg {
    width: 14px; height: 14px;
    stroke: var(--muted);
    fill: none;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .card-value {
    font-family: var(--font-mono);
    font-size: 36px;
    font-weight: 700;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .card-sub {
    font-family: var(--font-body);
    font-size: 13px;
    color: var(--muted);
    margin-top: 6px;
  }

  .kpi-testing .card-value { color: var(--blue); }
  .kpi-testing::after { content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 2px; background: var(--blue); opacity: 0.4; }
  .kpi-verified .card-value { color: var(--green); }
  .kpi-verified::after { content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 2px; background: var(--green); opacity: 0.4; }
  .kpi-uploading .card-value { color: var(--purple); }
  .kpi-uploading::after { content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 2px; background: var(--purple); opacity: 0.4; }
  .kpi-attention .card-value { color: var(--amber); }
  .kpi-attention::after { content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 2px; background: var(--amber); opacity: 0.4; }

  .chart-title {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 20px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .chart-title svg {
    width: 14px; height: 14px;
    stroke: var(--muted);
    fill: none;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .time-chart { position: relative; height: 200px; display: flex; align-items: flex-end; gap: 0; padding-top: 20px; }
  .time-bar-group {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    position: relative;
  }
  .time-bar-wrapper {
    width: 100%;
    height: 160px;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    position: relative;
  }
  .time-bar {
    width: 60%;
    border-radius: 6px 6px 2px 2px;
    position: relative;
    min-height: 4px;
    transition: opacity 0.2s ease;
    transform-origin: bottom;
    animation: growBar 0.6s ease-out both;
  }
  .time-bar-group:hover .time-bar { opacity: 0.85; }
  .time-bar-value {
    position: absolute;
    top: -22px;
    left: 50%;
    transform: translateX(-50%);
    font-family: var(--font-mono);
    font-size: 13px;
    font-weight: 700;
    color: var(--white);
    font-variant-numeric: tabular-nums;
  }
  .time-label {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--muted);
    text-align: center;
    letter-spacing: 0.5px;
  }

  .table-card { grid-column: span 4; }
  .table-controls {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
    gap: 16px;
  }
  .search-box {
    background: var(--surface);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    padding: 8px 14px 8px 36px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--white);
    outline: none;
    width: 280px;
    transition: border-color 0.2s ease;
  }
  .search-box:focus { border-color: var(--blue); }
  .search-box::placeholder { color: var(--muted); }
  .search-wrapper { position: relative; display: inline-block; }
  .search-wrapper svg {
    position: absolute;
    left: 12px;
    top: 50%;
    transform: translateY(-50%);
    width: 14px; height: 14px;
    stroke: var(--muted);
    fill: none;
    stroke-width: 2;
    pointer-events: none;
  }
  .filter-pills { display: flex; gap: 6px; flex-wrap: wrap; }
  .filter-pill {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 1px;
    text-transform: uppercase;
    padding: 6px 12px;
    border-radius: 20px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .filter-pill:hover { border-color: var(--white); color: var(--white); }
  .filter-pill.active { background: var(--white); color: var(--black); border-color: var(--white); }

  .skills-table { width: 100%; border-collapse: separate; border-spacing: 0; }
  .skills-table thead th {
    font-family: var(--font-mono);
    font-size: 9px;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: var(--muted);
    text-align: left;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    background: var(--surface-raised);
  }
  .skills-table tbody tr { transition: background 0.15s ease; }
  .skills-table tbody tr:hover { background: var(--surface-hover); }
  .skills-table tbody td {
    padding: 10px 16px;
    font-size: 13px;
    border-bottom: 1px solid var(--border-subtle);
    vertical-align: middle;
  }
  .skills-table .col-id {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--muted);
    white-space: nowrap;
  }
  .skills-table .col-name {
    font-family: var(--font-body);
    font-size: 14px;
    color: var(--white);
    font-weight: 500;
  }
  .skills-table .col-date {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  .status-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.5px;
    padding: 3px 10px;
    border-radius: 12px;
    white-space: nowrap;
  }
  .status-badge::before {
    content: '';
    width: 5px; height: 5px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .status-testing { background: var(--blue-dim); color: var(--blue); }
  .status-testing::before { background: var(--blue); }
  .status-verified { background: rgba(74, 232, 160, 0.08); color: var(--green); }
  .status-verified::before { background: var(--green); }
  .status-uploading { background: rgba(160, 125, 232, 0.08); color: var(--purple); }
  .status-uploading::before { background: var(--purple); }
  .status-attention { background: rgba(232, 196, 74, 0.08); color: var(--amber); }
  .status-attention::before { background: var(--amber); }

  .mind-tag {
    font-family: var(--font-mono);
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 4px;
    border: 1px solid var(--border);
    color: var(--muted);
    white-space: nowrap;
  }

  .table-scroll {
    max-height: 480px;
    overflow-y: auto;
    border-radius: 8px;
    border: 1px solid var(--border-subtle);
  }
  .table-scroll::-webkit-scrollbar { width: 6px; }
  .table-scroll::-webkit-scrollbar-track { background: transparent; }
  .table-scroll::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

  .table-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 12px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--muted);
  }

  .footer {
    padding: 24px 48px 32px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-top: 1px solid var(--border-subtle);
    margin: 0 48px;
  }
  .footer-left {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: var(--muted);
  }
  .footer-right {
    font-family: var(--font-body);
    font-size: 13px;
    color: var(--muted);
  }

  @keyframes fadeSlideUp {
    from { opacity: 0; transform: translateY(16px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .card, .header, .footer { animation: fadeSlideUp 0.5s ease-out both; }
  .card:nth-child(1) { animation-delay: 0.05s; }
  .card:nth-child(2) { animation-delay: 0.1s; }
  .card:nth-child(3) { animation-delay: 0.15s; }
  .card:nth-child(4) { animation-delay: 0.2s; }
  .card:nth-child(5) { animation-delay: 0.25s; }
  .card:nth-child(6) { animation-delay: 0.3s; }
  .card:nth-child(7) { animation-delay: 0.35s; }

  @keyframes growBar {
    from { transform: scaleY(0); }
    to { transform: scaleY(1); }
  }

  .full-width { grid-column: 1 / -1; }

  @media (max-width: 1024px) {
    .dashboard { grid-template-columns: 1fr 1fr; }
    .table-card { grid-column: 1 / -1; }
    .header, .dashboard { padding-left: 24px; padding-right: 24px; }
    .footer { margin: 0 24px; padding-left: 24px; padding-right: 24px; }
  }
  @media (max-width: 640px) {
    .dashboard { grid-template-columns: 1fr 1fr; gap: 10px; }
    .header { flex-direction: column; gap: 16px; padding: 24px 16px 0; }
    .header-right { align-items: flex-start; }
    .header h1 { font-size: 24px; }
    .header-total { font-size: 36px; }
    .dashboard { padding: 20px 16px 24px; }
    .footer { margin: 0 16px; padding: 16px 0 24px; }
    .card { padding: 16px; border-radius: 10px; }
    .card-value { font-size: 28px; }
    .card-label { font-size: 9px; letter-spacing: 1.5px; margin-bottom: 8px; }
    .card-sub { font-size: 11px; }
    .time-chart { height: 160px; }
    .time-bar-wrapper { height: 120px; }
    .table-controls { flex-direction: column; align-items: stretch; gap: 12px; }
    .table-controls > div { flex-wrap: wrap; }
    .filter-pills { overflow-x: auto; flex-wrap: nowrap; -webkit-overflow-scrolling: touch; padding-bottom: 4px; }
    .filter-pill { flex-shrink: 0; font-size: 9px; padding: 5px 10px; }
    .search-box { width: 100%; }
    .search-wrapper { width: 100%; display: block; }
    .table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .skills-table { min-width: 580px; }
    .skills-table tbody td { padding: 8px 12px; font-size: 12px; }
    .skills-table thead th { padding: 8px 12px; font-size: 8px; }
    .table-footer { flex-direction: column; gap: 4px; align-items: flex-start; font-size: 10px; }
    .footer-left, .footer-right { font-size: 9px; }
  }
  @media (max-width: 380px) {
    .dashboard { grid-template-columns: 1fr 1fr; gap: 8px; }
    .card-value { font-size: 24px; }
    .header h1 { font-size: 20px; }
  }
</style>
</head>
<body>

<!-- generated by scripts/sync-linear.mjs — do not edit manually -->

<div class="header">
  <div class="header-left">
    <div class="header-badge">Live Pipeline</div>
    <h1>Mind <span>Skills</span> Dashboard</h1>
  </div>
  <div class="header-right">
    <div class="header-date">${today}</div>
    <div class="header-total">${kpis.total}</div>
    <div class="header-total-label">total skills tracked</div>
  </div>
</div>

<div class="dashboard">

  <div class="card kpi-uploading">
    <div class="card-label">
      <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
      Uploading
    </div>
    <div class="card-value">${kpis.uploading}</div>
    <div class="card-sub">Queued for registry</div>
  </div>

  <div class="card kpi-testing">
    <div class="card-label">
      <svg viewBox="0 0 24 24"><path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"/><path d="M8.5 2h7"/><path d="M7 16h10"/></svg>
      Testing
    </div>
    <div class="card-value">${kpis.testing}</div>
    <div class="card-sub">In functional validation</div>
  </div>

  <div class="card kpi-verified">
    <div class="card-label">
      <svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>
      Mind Verified
    </div>
    <div class="card-value">${kpis.verified}</div>
    <div class="card-sub">Passed all checks</div>
  </div>

  <div class="card kpi-attention">
    <div class="card-label">
      <svg viewBox="0 0 24 24"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      Needs Attention
    </div>
    <div class="card-value">${kpis.attention}</div>
    <div class="card-sub">Blocked or failing</div>
  </div>

  <div class="card full-width">
    <div class="chart-title">
      <svg viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
      Time Series
    </div>
    <div class="time-chart">
${timeBarHTML}
    </div>
  </div>

  <div class="card table-card">
    <div class="table-controls">
      <div class="chart-title" style="margin-bottom:0">
        <svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5"/><path d="M8.5 8.5v.01"/><path d="M16 15.5v.01"/><path d="M12 12v.01"/><path d="M11 17v.01"/><path d="M7 14v.01"/></svg>
        All Pipeline Skills
      </div>
      <div style="display:flex;align-items:center;gap:12px;">
        <div class="filter-pills">
          <button class="filter-pill active" onclick="filterTable('all')">All</button>
          <button class="filter-pill" onclick="filterTable('Testing')">Testing</button>
          <button class="filter-pill" onclick="filterTable('Mind Verified')">Verified</button>
          <button class="filter-pill" onclick="filterTable('Uploading')">Uploading</button>
          <button class="filter-pill" onclick="filterTable('Needs Attention')">Attention</button>
        </div>
        <div class="search-wrapper">
          <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="text" class="search-box" placeholder="Search skills..." oninput="searchTable(this.value)" aria-label="Search skills">
        </div>
      </div>
    </div>

    <div class="table-scroll">
      <table class="skills-table" id="skillsTable">
        <thead>
          <tr>
            <th style="width:80px">ID</th>
            <th>Skill Name</th>
            <th style="width:120px">Status</th>
            <th style="width:80px">Mind</th>
            <th style="width:90px">Created</th>
          </tr>
        </thead>
        <tbody id="skillsBody">
${rowsHTML}
        </tbody>
      </table>
    </div>
    <div class="table-footer">
      <span id="tableCount">Showing ${skills.length} of ${skills.length} skills</span>
      <span>${skills.length} active pipeline skills</span>
    </div>
  </div>

</div>

<div class="footer">
  <div class="footer-left">Animoca Minds &middot; Skills Repository</div>
  <div class="footer-right">Mind Skills Pipeline &middot; animocaminds.ai</div>
</div>

<script>
const allRows = document.querySelectorAll('#skillsBody tr');
const totalCount = allRows.length;
let currentFilter = 'all';
let currentSearch = '';

function filterTable(status) {
  currentFilter = status;
  document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
  event.target.classList.add('active');
  applyFilters();
}

function searchTable(query) {
  currentSearch = query.toLowerCase();
  applyFilters();
}

function applyFilters() {
  let visible = 0;
  allRows.forEach(row => {
    const matchStatus = currentFilter === 'all' || row.dataset.status === currentFilter;
    const matchSearch = !currentSearch ||
      row.dataset.name.includes(currentSearch) ||
      row.querySelector('.col-id').textContent.toLowerCase().includes(currentSearch) ||
      row.querySelector('.mind-tag').textContent.toLowerCase().includes(currentSearch);
    const show = matchStatus && matchSearch;
    row.style.display = show ? '' : 'none';
    if (show) visible++;
  });
  document.getElementById('tableCount').textContent = 'Showing ' + visible + ' of ' + totalCount + ' skills';
}
</script>

</body>
</html>`;
}

// ── Main ──
async function main() {
  console.log('Fetching issues from Linear...');
  const raw = await fetchAllIssues();
  console.log(`Fetched ${raw.length} total issues`);

  // Filter to pipeline statuses only
  const pipeline = raw.filter(i => PIPELINE_STATUSES.includes(i.state.name));
  console.log(`${pipeline.length} in active pipeline`);

  // Map to dashboard format
  const statusClassMap = {
    'Testing': 'status-testing',
    'Mind Verified': 'status-verified',
    'Human Verified': 'status-verified',
    'Uploading': 'status-uploading',
    'Needs Attention': 'status-attention',
  };

  const skills = pipeline.map(i => ({
    id: i.identifier,
    name: cleanTitle(i.title),
    status: i.state.name,
    statusClass: statusClassMap[i.state.name] || '',
    mind: extractMind(i.labels),
    date: shortDate(i.createdAt),
  }));

  // Sort: Verified first, then Testing, Uploading, Attention
  const statusOrder = { 'Mind Verified': 0, 'Human Verified': 0, 'Testing': 1, 'Uploading': 2, 'Needs Attention': 3 };
  skills.sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9));

  // KPIs
  const kpis = {
    total: raw.length,
    testing: pipeline.filter(i => i.state.name === 'Testing').length,
    verified: pipeline.filter(i => ['Mind Verified', 'Human Verified'].includes(i.state.name)).length,
    uploading: pipeline.filter(i => i.state.name === 'Uploading').length,
    attention: pipeline.filter(i => i.state.name === 'Needs Attention').length,
  };

  const timeSeries = buildTimeSeries(pipeline);
  const today = fmtDate(new Date().toISOString());
  const html = generateHTML(skills, kpis, timeSeries, today);

  const fs = await import('fs');
  const path = await import('path');
  const outPath = path.join(process.cwd(), 'index.html');
  fs.writeFileSync(outPath, html, 'utf-8');
  console.log(`Written ${outPath} (${skills.length} skills)`);
}

main().catch(e => { console.error(e); process.exit(1); });
