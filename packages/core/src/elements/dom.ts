/**
 * @module elements/dom
 * Just enough DOM building for the elements to stay readable without a
 * framework: `h('button', { onclick }, 'Save')`.
 */

export type Child = Node | string | number | false | null | undefined | ReadonlyArray<Child>;

type Props = Record<string, unknown> & { class?: string; style?: string };

/** Always set as attributes: their properties want other types, or do not exist on every element */
const ATTRIBUTES = new Set(['class', 'style', 'role', 'spellcheck', 'autocomplete', 'tabindex', 'for']);

/**
 * Makes an element. Props starting with `on` become listeners, `class` and
 * `style` are set as attributes, booleans toggle attributes, anything else is
 * set as a property when the element has one and an attribute otherwise.
 */
export function h(tag: string, props: Props | null = null, ...children: Child[]): HTMLElement {
  const element = globalThis.document.createElement(tag);
  for (const [name, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (name.startsWith('on') && typeof value === 'function') {
      element.addEventListener(name.slice(2), value as EventListener);
    } else if (value === true) {
      element.setAttribute(name, '');
    } else if (ATTRIBUTES.has(name) || name.startsWith('data-') || name.startsWith('aria-') || !(name in element)) {
      element.setAttribute(name, String(value));
    } else {
      (element as unknown as Record<string, unknown>)[name] = value;
    }
  }
  append(element, children);
  return element;
}

function append(parent: Node, children: ReadonlyArray<Child>): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(parent, child);
    else parent.appendChild(typeof child === 'object' ? (child as Node) : globalThis.document.createTextNode(String(child)));
  }
}

/** Markup from trusted, constant strings — an icon, never anything a person typed. */
export function svg(markup: string): Element {
  const template = globalThis.document.createElement('template');
  template.innerHTML = markup.trim();
  return template.content.firstElementChild!;
}

/**
 * Adds a stylesheet to the document once, by id.
 *
 * A constructed stylesheet where the browser has them — it needs no inline
 * `<style>`, so a strict Content-Security-Policy is no obstacle — and a style
 * element otherwise.
 */
export function adoptStyles(id: string, css: string): void {
  const doc = globalThis.document as Document & { __weaveStyles?: Set<string> };
  doc.__weaveStyles ??= new Set();
  if (doc.__weaveStyles.has(id)) return;
  doc.__weaveStyles.add(id);

  if ('adoptedStyleSheets' in doc && typeof CSSStyleSheet === 'function' && 'replaceSync' in CSSStyleSheet.prototype) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
    return;
  }
  const style = doc.createElement('style');
  style.id = id;
  style.textContent = css;
  doc.head.appendChild(style);
}
