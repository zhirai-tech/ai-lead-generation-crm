/** Lightweight SVG charts drawn by hand (no chart library). */
import { el, svg as svgNode } from '../utils/dom.mjs';
import { formatNumber } from '../utils/format.mjs';

const NS = 'http://www.w3.org/2000/svg';
let gradientSeq = 0;

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    node.setAttribute(key, String(value));
  }
  return node;
}

function gradientDefs(id, from = 'rgba(34,211,238,.32)', to = 'rgba(34,211,238,0)') {
  const defs = svgEl('defs');
  const gradient = svgEl('linearGradient', { id, x1: '0', y1: '0', x2: '0', y2: '1' });
  gradient.appendChild(svgEl('stop', { offset: '0%', 'stop-color': from }));
  gradient.appendChild(svgEl('stop', { offset: '100%', 'stop-color': to }));
  defs.appendChild(gradient);
  return defs;
}

export function sparkline(values = [], { width = 160, height = 36, color = '#22d3ee' } = {}) {
  const numbers = values.map((value) => Number(value) || 0);
  const max = Math.max(1, ...numbers);
  const min = Math.min(...numbers, 0);
  const span = max - min || 1;
  const step = numbers.length > 1 ? width / (numbers.length - 1) : width;
  const points = numbers.map((value, index) => `${(index * step).toFixed(2)},${(height - 2 - ((value - min) / span) * (height - 4)).toFixed(2)}`);
  const svg = svgEl('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, width, height, role: 'img' });
  if (points.length > 1) {
    const area = svgEl('polygon', { points: `0,${height} ${points.join(' ')} ${width},${height}`, fill: 'rgba(34,211,238,.12)' });
    svg.appendChild(area);
    svg.appendChild(svgEl('polyline', { points: points.join(' '), fill: 'none', stroke: color, 'stroke-width': '1.6', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  }
  return svg;
}

export function lineChart(items = [], { height = 150, color = '#22d3ee', valueFormat = (value) => formatNumber(value) } = {}) {
  const width = 620;
  const padLeft = 6;
  const padBottom = 20;
  const innerW = width - padLeft * 2;
  const innerH = height - padBottom - 8;
  const values = items.map((item) => Number(item.value) || 0);
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? innerW / (values.length - 1) : innerW;
  const points = values.map((value, index) => [padLeft + index * step, 8 + innerH - (value / max) * innerH]);
  const svg = svgEl('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': '趋势图' });
  const gradientId = `line-grad-${++gradientSeq}`;
  svg.appendChild(gradientDefs(gradientId));
  for (let i = 0; i <= 3; i += 1) {
    const y = 8 + (innerH / 3) * i;
    svg.appendChild(svgEl('line', { x1: padLeft, y1: y, x2: width - padLeft, y2: y, stroke: 'rgba(148,163,184,.12)', 'stroke-width': '1' }));
  }
  if (points.length) {
    const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point[0].toFixed(1)},${point[1].toFixed(1)}`).join(' ');
    const area = `${path} L${points[points.length - 1][0].toFixed(1)},${(8 + innerH).toFixed(1)} L${points[0][0].toFixed(1)},${(8 + innerH).toFixed(1)} Z`;
    svg.appendChild(svgEl('path', { d: area, fill: `url(#${gradientId})` }));
    svg.appendChild(svgEl('path', { d: path, fill: 'none', stroke: color, 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    for (const point of points) {
      svg.appendChild(svgEl('circle', { cx: point[0], cy: point[1], r: '2.2', fill: '#05070d', stroke: color, 'stroke-width': '1.4' }));
    }
    const labelEvery = Math.ceil(items.length / 6);
    items.forEach((item, index) => {
      if (index % labelEvery !== 0 && index !== items.length - 1) return;
      const label = svgEl('text', { x: padLeft + index * step, y: height - 4, fill: '#6d7f9b', 'font-size': '9', 'text-anchor': 'middle' });
      label.textContent = item.label || '';
      svg.appendChild(label);
    });
    const tickTop = svgEl('text', { x: width - padLeft, y: 10, fill: '#6d7f9b', 'font-size': '9', 'text-anchor': 'end' });
    tickTop.textContent = valueFormat(max);
    svg.appendChild(tickTop);
  }
  return svg;
}

export function barChart(items = [], { height = 150, color = '#38bdf8', showValues = true } = {}) {
  const width = 620;
  const padBottom = 20;
  const innerH = height - padBottom - 14;
  const values = items.map((item) => Number(item.value) || 0);
  const max = Math.max(1, ...values);
  const gap = 8;
  const barWidth = Math.max(6, (width - gap * (items.length + 1)) / Math.max(1, items.length));
  const svg = svgEl('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': '柱状图' });
  items.forEach((item, index) => {
    const x = gap + index * (barWidth + gap);
    const barHeight = Math.max(2, (values[index] / max) * innerH);
    const y = 8 + innerH - barHeight;
    svg.appendChild(svgEl('rect', { x, y, width: barWidth, height: barHeight, rx: '3', fill: color, opacity: '0.82' }));
    if (showValues) {
      const valueText = svgEl('text', { x: x + barWidth / 2, y: Math.max(10, y - 4), fill: '#a4b3ca', 'font-size': '9', 'text-anchor': 'middle' });
      valueText.textContent = formatNumber(item.value);
      svg.appendChild(valueText);
    }
    const label = svgEl('text', { x: x + barWidth / 2, y: height - 4, fill: '#6d7f9b', 'font-size': '9', 'text-anchor': 'middle' });
    label.textContent = item.label || '';
    svg.appendChild(label);
  });
  return svg;
}

export function donutChart(items = [], { size = 132, thickness = 12, centerLabel = '', centerValue = '' } = {}) {
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const total = items.reduce((sum, item) => sum + (Number(item.value) || 0), 0);
  const svg = svgEl('svg', { class: 'chart donut', viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: 'img', 'aria-label': '占比图' });
  const group = svgEl('g', { transform: `rotate(-90 ${size / 2} ${size / 2})` });
  group.appendChild(svgEl('circle', { cx: size / 2, cy: size / 2, r: radius, fill: 'none', stroke: 'rgba(148,163,184,.12)', 'stroke-width': thickness }));
  let offset = 0;
  for (const item of items) {
    const value = Number(item.value) || 0;
    if (value <= 0) continue;
    const fraction = total > 0 ? value / total : 0;
    const dash = fraction * circumference;
    group.appendChild(
      svgEl('circle', {
        cx: size / 2,
        cy: size / 2,
        r: radius,
        fill: 'none',
        stroke: item.color || '#22d3ee',
        'stroke-width': thickness,
        'stroke-dasharray': `${Math.max(0, dash - 2)} ${circumference}`,
        'stroke-dashoffset': `${-offset}`,
        'stroke-linecap': 'round',
      }),
    );
    offset += dash;
  }
  svg.appendChild(group);
  if (centerValue !== '') {
    const valueText = svgEl('text', { x: size / 2, y: size / 2 + 5, fill: '#e9eef9', 'font-size': '18', 'font-weight': '700', 'text-anchor': 'middle' });
    valueText.textContent = centerValue;
    svg.appendChild(valueText);
  }
  if (centerLabel) {
    const labelText = svgEl('text', { x: size / 2, y: size / 2 + 21, fill: '#6d7f9b', 'font-size': '9', 'text-anchor': 'middle' });
    labelText.textContent = centerLabel;
    svg.appendChild(labelText);
  }
  return svg;
}

export function progressRow({ label, value, max = 100, display = null }) {
  const row = el('div', 'funnel-row');
  appendChildSafe(row, el('span', 'funnel-label', label));
  const bar = el('div', 'funnel-bar');
  const fill = el('span', '');
  fill.style.setProperty('--w', `${Math.min(100, max > 0 ? (value / max) * 100 : 0)}%`);
  bar.appendChild(fill);
  appendChildSafe(row, bar);
  appendChildSafe(row, el('span', 'funnel-value', display ?? formatNumber(value)));
  return row;
}

function appendChildSafe(parent, child) {
  parent.appendChild(child);
}

export default { sparkline, lineChart, barChart, donutChart, progressRow };
