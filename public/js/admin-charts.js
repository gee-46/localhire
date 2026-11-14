// Dependency-free SVG charts for the admin console. Every chart is drawn from the data it is given (nothing is
// invented), has a text summary for screen readers, and shows exact values on hover/focus.
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const COLORS = ['#5b3df5', '#12805c', '#f59e0b', '#ef4444', '#0ea5e9', '#a855f7'];

  const niceMax = (v) => {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  };
  const fmt = (v, money) => (money ? '₹' : '') + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const short = (b) => (/^\d{4}-\d{2}-\d{2}$/.test(b) ? `${b.slice(8)}/${b.slice(5, 7)}` : b);

  // Shared tooltip
  let tip = null;
  const showTip = (html, x, y) => {
    if (!tip) { tip = document.createElement('div'); tip.className = 'ac-tip'; tip.setAttribute('role', 'tooltip'); document.body.appendChild(tip); }
    tip.innerHTML = html; tip.style.display = 'block';
    const w = tip.offsetWidth; tip.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, x - w / 2))}px`; tip.style.top = `${Math.max(8, y - tip.offsetHeight - 12)}px`;
  };
  const hideTip = () => { if (tip) tip.style.display = 'none'; };

  // Time-series chart. series: [{ name, values: [], color?, type: 'bar'|'line' }], labels: bucket strings.
  function timeSeries(el, { labels, series, money = false, height = 240, title = 'Chart' }) {
    const W = 720; const H = height; const m = { l: 48, r: 12, t: 12, b: 28 };
    const iw = W - m.l - m.r; const ih = H - m.t - m.b;
    const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
    const n = labels.length;
    if (!n || series.every((s) => s.values.every((v) => !v))) {
      el.innerHTML = `<div class="ac-empty-chart" role="img" aria-label="${esc(title)}: no data in this period">No data in this period.</div>`; return;
    }
    const x = (i) => m.l + (n === 1 ? iw / 2 : (iw * (i + 0.5)) / n);
    const y = (v) => m.t + ih - (v / max) * ih;
    const bars = series.filter((s) => s.type !== 'line'); const lines = series.filter((s) => s.type === 'line');
    const slot = iw / n; const bw = Math.max(2, Math.min(28, (slot * 0.72) / Math.max(1, bars.length)));
    let g = '';
    for (let i = 0; i <= 4; i += 1) { const v = (max / 4) * i; g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="#eaecf0"/><text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end" font-size="10" fill="#667085">${esc(fmt(v, money))}</text>`; }
    const every = Math.max(1, Math.ceil(n / 10));
    labels.forEach((l, i) => { if (i % every === 0) g += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#667085">${esc(short(l))}</text>`; });
    bars.forEach((s, si) => {
      const color = s.color || COLORS[series.indexOf(s) % COLORS.length];
      s.values.forEach((v, i) => { if (v > 0) g += `<rect x="${x(i) - (bw * bars.length) / 2 + si * bw}" y="${y(v)}" width="${bw - 1}" height="${m.t + ih - y(v)}" rx="2" fill="${color}"/>`; });
    });
    lines.forEach((s) => {
      const color = s.color || COLORS[series.indexOf(s) % COLORS.length];
      g += `<polyline fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" points="${s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')}"/>`;
      if (n <= 40) s.values.forEach((v, i) => { g += `<circle cx="${x(i)}" cy="${y(v)}" r="2.5" fill="${color}"/>`; });
    });
    // hover/focus columns
    labels.forEach((l, i) => { g += `<rect class="ac-hit" data-i="${i}" x="${x(i) - slot / 2}" y="${m.t}" width="${slot}" height="${ih}" fill="transparent" tabindex="0"/>`; });
    const summary = `${title}. ` + series.map((s) => `${s.name}: total ${fmt(s.values.reduce((a, b) => a + b, 0), money)}`).join('; ');
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(summary)}" preserveAspectRatio="xMidYMid meet">${g}</svg>
      <div class="ac-legend">${series.map((s, i) => `<span><i style="background:${s.color || COLORS[i % COLORS.length]}"></i>${esc(s.name)}</span>`).join('')}</div>`;
    const tipFor = (i) => `<b>${esc(labels[i])}</b>` + series.map((s, si) => `<div><i style="background:${s.color || COLORS[si % COLORS.length]}"></i>${esc(s.name)}: ${esc(fmt(s.values[i], money))}</div>`).join('');
    el.querySelectorAll('.ac-hit').forEach((r) => {
      const i = Number(r.dataset.i);
      const at = (e) => { const b = r.getBoundingClientRect(); showTip(tipFor(i), (e && e.clientX) || b.left + b.width / 2, (e && e.clientY) || b.top); };
      r.addEventListener('mousemove', at); r.addEventListener('mouseleave', hideTip); r.addEventListener('focus', () => at()); r.addEventListener('blur', hideTip);
    });
  }

  // Horizontal bars (rankings). rows: [{ label, value, sub }]
  function hbars(el, { rows, money = false, title = 'Ranking', empty = 'No data in this period.' }) {
    if (!rows.length) { el.innerHTML = `<div class="ac-empty-chart" role="img" aria-label="${esc(title)}: ${esc(empty)}">${esc(empty)}</div>`; return; }
    const max = Math.max(...rows.map((r) => r.value), 1);
    el.innerHTML = `<ol class="ac-hbars" aria-label="${esc(title)}">${rows.map((r, i) => `<li><div class="ac-hb-top"><span>${esc(r.label)}</span><b>${esc(fmt(r.value, money))}</b></div><div class="ac-hb-track"><div class="ac-hb-fill" style="width:${Math.max(2, (r.value / max) * 100)}%;background:${COLORS[i % COLORS.length]}"></div></div>${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</li>`).join('')}</ol>`;
  }

  window.AdminCharts = { timeSeries, hbars, esc };
}());
