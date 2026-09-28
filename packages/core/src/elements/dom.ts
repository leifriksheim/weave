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
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K];
export function h(tag: string, props?: Props | null, ...children: Child[]): HTMLElement;
export function h(tag: string, props: Props | null = null, ...children: Child[]): HTMLElement {
  const element = globalThis.document.createElement(tag);
  for (const [name, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (name.startsWith('on') && typeof value === 'function') {
      element.addEventListener(name.slice(2), (event) => {
        Reflect.apply(value, element, [event]);
      });
    } else if (value === true) {
      element.setAttribute(name, '');
    } else if (
      ATTRIBUTES.has(name) ||
      name.startsWith('data-') ||
      name.startsWith('aria-') ||
      !(name in element)
    ) {
      // What setAttribute would make of it anyway; props hold text and numbers.
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- the DOM's own conversion
      element.setAttribute(name, String(value));
    } else if (!Reflect.set(element, name, value)) {
      throw new TypeError(`Cannot set ${name} on <${tag}>`);
    }
  }
  append(element, children);
  return element;
}

// Array.isArray does not narrow a readonly array out of a union.
const isChildList = (child: Child): child is ReadonlyArray<Child> => Array.isArray(child);

function append(parent: Node, children: ReadonlyArray<Child>): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (isChildList(child)) append(parent, child);
    else if (typeof child === 'object') parent.appendChild(child);
    else parent.appendChild(globalThis.document.createTextNode(String(child)));
  }
}

/** Markup from trusted, constant strings — an icon, never anything a person typed. */
export function svg(markup: string): Element {
  const template = globalThis.document.createElement('template');
  template.innerHTML = markup.trim();
  return template.content.firstElementChild!;
}

/** Kept on the document itself, so two copies of this library on one page still add each sheet once */
function adoptedIds(doc: Document): Set<unknown> {
  const found: unknown = Reflect.get(doc, '__weaveStyles');
  if (found instanceof Set) return found;
  const ids = new Set<unknown>();
  Reflect.set(doc, '__weaveStyles', ids);
  return ids;
}

/**
 * Adds a stylesheet to the document once, by id.
 *
 * A constructed stylesheet where the browser has them — it needs no inline
 * `<style>`, so a strict Content-Security-Policy is no obstacle — and a style
 * element otherwise.
 */
export function adoptStyles(id: string, css: string): void {
  const doc = globalThis.document;
  const adopted = adoptedIds(doc);
  if (adopted.has(id)) return;
  adopted.add(id);

  if (
    'adoptedStyleSheets' in doc &&
    typeof CSSStyleSheet === 'function' &&
    'replaceSync' in CSSStyleSheet.prototype
  ) {
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
