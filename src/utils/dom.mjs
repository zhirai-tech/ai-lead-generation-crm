/**
 * Tiny DOM helpers. All user data is inserted as text nodes (never innerHTML),
 * which keeps the UI safe from stored XSS. Static icon markup is the only
 * innerHTML use and never contains user data.
 */
export function el(tag = 'div', className = '', ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  append(node, children);
  return node;
}

export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
  return parent;
}

export function text(value) {
  return document.createTextNode(value === null || value === undefined ? '' : String(value));
}

export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Create an SVG element from trusted static markup. */
export function svg(markup, { size = 16, className = '' } = {}) {
  const template = document.createElement('template');
  template.innerHTML = String(markup).trim();
  const node = template.content.firstElementChild;
  if (!node) throw new Error('invalid svg markup');
  if (className) node.setAttribute('class', className);
  if (size) {
    node.setAttribute('width', String(size));
    node.setAttribute('height', String(size));
    node.setAttribute('aria-hidden', 'true');
    node.setAttribute('focusable', 'false');
  }
  return node;
}

export function on(target, event, handler, options) {
  target.addEventListener(event, handler, options);
  return () => target.removeEventListener(event, handler, options);
}

export function qs(selector, root = document) {
  return root.querySelector(selector);
}

export function qsa(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

export function debounce(fn, delay = 250) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export function link(href, label, className = '') {
  const anchor = el('a', className, label);
  anchor.href = href;
  return anchor;
}

export function setChildren(parent, ...children) {
  clear(parent);
  append(parent, children);
  return parent;
}

/** Set inline custom properties through CSSOM (allowed by CSP). */
export function cssVar(node, name, value) {
  node.style.setProperty(name, value);
  return node;
}

export function attr(node, attrs) {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'dataset') Object.assign(node.dataset, value);
    else if (typeof value === 'function') node[key] = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  return node;
}

export function escapeAttr(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

export default { el, append, text, clear, svg, on, qs, qsa, debounce, link, setChildren, cssVar, attr };
