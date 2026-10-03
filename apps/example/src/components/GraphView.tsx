import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import { useLive, useNode, useProfiles } from '@weaveprotocol/core/react';
import type { NodeCollection, NodeRecord, SpaceSummary } from '@weaveprotocol/core';
import { collectionLabel, humanize, recordLabel } from '../derive/schema-ui';
import { nameOf, peopleFrom } from '../derive/people';
import { ago } from '../derive/time';
import { Avatar } from '@weave/app-shared/Avatar';
import { RecordPanel } from './RecordPanel';
import { styles, palette, ui } from '../styles';
import { Person } from './Person';

/** A dot on the map: a record, or — when people are shown — a person */
interface Dot {
  readonly id: string;
  readonly record?: NodeRecord;
  readonly did?: string;
  readonly collection: string;
  readonly label: string;
  readonly color: string;
  readonly r: number;
}

/** A line between two dots, labelled with how the one points at the other */
interface Line {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly label: string;
}

/** Where a dot is, and where it is heading — kept outside React so it can move every frame */
interface Place {
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number | null;
  fy: number | null;
}

interface Spring {
  readonly s: number;
  readonly t: number;
  readonly distance: number;
  readonly strength: number;
  readonly bias: number;
}

interface View {
  x: number;
  y: number;
  k: number;
}

type Gesture =
  | { kind: 'pan'; sx: number; sy: number; view: View; moved: boolean }
  | { kind: 'dot'; id: string; sx: number; sy: number; moved: boolean };

const HEIGHT = 600;
/** How many records the map starts with, how many more each "Show more" adds, and never more than */
const BUDGET = 300;
const BUDGET_STEP = 300;
const BUDGET_MAX = 1000;
/** Records walked to from the panel that the budget left out, kept on the map — the most recent ones */
const WALKED_MAX = 100;
const PANEL = 320;
const RECORD_PANEL = 560;
const PERSON = 'person:';

/** Who a record is by: whoever created it, else whoever the signing key acted for */
const writerOf = (record: NodeRecord) => record.createdBy ?? record.root ?? record.author;

/**
 * Collections get a colour each: the standard ones (comments, reactions,
 * tags…) stay grey so they read as notes on records, the space's own ones get
 * muted hues spaced far enough apart to tell apart.
 */
function coloursFor(names: ReadonlyArray<string>): Map<string, string> {
  const greys = ['#8f8f8f', '#b4b4b4', '#6b6b6b', '#c8c8c8', '#a3a3a3'];
  const map = new Map<string, string>();
  let grey = 0;
  let hue = 0;
  for (const name of names) {
    if (name.startsWith('std.')) map.set(name, greys[grey++ % greys.length]!);
    else map.set(name, `hsl(${Math.round((212 + hue++ * 137.5) % 360)} 34% 50%)`);
  }
  return map;
}

/** One step of d3-force's recipe: springs, an all-pairs push (why the map caps its dots), a pull to the middle. */
function tick(places: ReadonlyArray<Place>, springs: ReadonlyArray<Spring>, alpha: number): void {
  for (const l of springs) {
    const s = places[l.s]!;
    const t = places[l.t]!;
    let dx = t.x + t.vx - s.x - s.vx;
    let dy = t.y + t.vy - s.y - s.vy;
    const d = Math.hypot(dx, dy) || 0.01;
    const k = ((d - l.distance) / d) * alpha * l.strength;
    dx *= k;
    dy *= k;
    t.vx -= dx * l.bias;
    t.vy -= dy * l.bias;
    s.vx += dx * (1 - l.bias);
    s.vy += dy * (1 - l.bias);
  }
  const push = 220 * alpha;
  for (let i = 0; i < places.length; i++) {
    const a = places[i]!;
    for (let j = i + 1; j < places.length; j++) {
      const b = places[j]!;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let l2 = dx * dx + dy * dy;
      if (l2 > 250_000) continue;
      if (l2 < 1) {
        dx = Math.random() - 0.5;
        dy = Math.random() - 0.5;
        l2 = 1;
      }
      const w = push / l2;
      a.vx -= dx * w;
      a.vy -= dy * w;
      b.vx += dx * w;
      b.vy += dy * w;
    }
  }
  for (const p of places) {
    p.vx -= p.x * 0.03 * alpha;
    p.vy -= p.y * 0.03 * alpha;
    if (p.fx !== null && p.fy !== null) {
      p.x = p.fx;
      p.y = p.fy;
      p.vx = 0;
      p.vy = 0;
    } else {
      p.vx *= 0.6;
      p.vy *= 0.6;
      p.x += p.vx;
      p.y += p.vy;
    }
  }
}

/**
 * How many of each collection's records to show within a budget: an equal
 * share each, with what the small ones don't use passed on to the bigger ones.
 */
function shares(
  sizes: ReadonlyArray<readonly [string, number]>,
  budget: number,
): ReadonlyArray<readonly [string, number]> {
  const smallestFirst = [...sizes].sort((a, b) => a[1] - b[1]);
  let left = budget;
  return smallestFirst.map(([name, size], i) => {
    const take = Math.min(size, Math.floor(left / (smallestFirst.length - i)));
    left -= take;
    return [name, take] as const;
  });
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const short = (text: string, max = 28) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Explore: every record in a space as a dot and every link as a line, within a budget the layout can draw. */
export function GraphView({
  space,
  collections,
}: {
  space: SpaceSummary;
  collections: ReadonlyArray<NodeCollection>;
}) {
  const node = useNode();
  const uid = useId().replace(/:/g, '');
  // Which collections are on the map: null for all of them, else the ones picked.
  const [chosen, setChosen] = useState<ReadonlySet<string> | null>(null);
  const [budget, setBudget] = useState(BUDGET);
  const [walked, setWalked] = useState<ReadonlyArray<string>>([]);

  // Every collection with records, most-used first. The counts come from the space, not from what is loaded.
  const counts = useMemo(
    () =>
      collections
        .filter((c) => c.records > 0)
        .map((c) => [c.name, c.records] as const)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    [collections],
  );
  const inView = counts.filter(([name]) => !chosen || chosen.has(name));
  const total = inView.reduce((sum, [, n]) => sum + n, 0);
  // A space can hold far more than a force layout can draw: only the newest of each collection, within the budget.
  const plan = shares(inView, budget).filter(([, n]) => n > 0);
  const planKey = plan.map(([name, n]) => `${name}:${n}`).join(',');
  const records = useLive(
    space.id,
    async (): Promise<NodeRecord[]> => {
      const pages = await Promise.all(
        plan.map(([collection, limit]) =>
          node.records.query(space.id, { collection, sort: { '@createdAt': 'desc' }, limit }),
        ),
      );
      const loaded: NodeRecord[] = pages.flatMap((page) => page.records);
      const have = new Set(loaded.map((r) => r.key));
      const extra = await Promise.all(
        walked.filter((key) => !have.has(key)).map((key) => node.records.get(space.id, key)),
      );
      for (const r of extra) if (r && !r.deleted) loaded.push(r);
      return loaded;
    },
    [planKey, walked.join(',')],
  );
  const loadedCount = records?.length ?? 0;
  const profiles = useProfiles(space.id);
  const profileKey = profiles.map((p) => `${p.did}=${p.name}`).join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const people = useMemo(() => peopleFrom(profiles), [profileKey]);

  const [showPeople, setShowPeople] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [view, setViewState] = useState<View>({ x: 0, y: 0, k: 1 });
  const [size, setSize] = useState({ w: 0, h: HEIGHT });
  // Where each dot is drawn: the simulation moves its places in refs, and each frame copies them here.
  const [drawn, setDrawn] = useState<ReadonlyMap<string, { x: number; y: number }>>(() => new Map());
  const [dragging, setDragging] = useState<Gesture['kind'] | null>(null);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const viewRef = useRef(view);
  const places = useRef(new Map<string, Place>());
  const sim = useRef<{ places: Place[]; springs: Spring[] }>({ places: [], springs: [] });
  const heat = useRef({ alpha: 1, target: 0 });
  const loop = useRef<number | null>(null);
  const flight = useRef<number | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const pendingFly = useRef<string | null>(null);
  const fitted = useRef(false);

  const setView = (next: View) => {
    viewRef.current = next;
    setViewState(next);
  };

  const schemaOf = (name: string) => collections.find((c) => c.name === name)?.schema ?? null;
  const all = records ?? [];
  const byKey = useMemo(() => new Map(all.map((r) => [r.key, r])), [records]); // eslint-disable-line react-hooks/exhaustive-deps

  const colours = useMemo(() => coloursFor(counts.map(([name]) => name)), [counts]);
  const nameOfCollection = (name: string) => {
    const c = collections.find((x) => x.name === name);
    return c ? collectionLabel(c) : humanize(name.split('.').pop() ?? name);
  };

  // The dots and lines on screen: what was loaded, and a line wherever both ends were.
  const graph = useMemo(() => {
    const shown = all;
    const keys = new Set(shown.map((r) => r.key));
    const pairs = new Map<string, { from: string; to: string; rels: string[] }>();
    const degree = new Map<string, number>();
    const bump = (id: string) => degree.set(id, (degree.get(id) ?? 0) + 1);
    for (const r of shown) {
      for (const link of r.links) {
        if (link.to === r.key || !keys.has(link.to)) continue;
        const id = `${r.key}>${link.to}`;
        const pair = pairs.get(id) ?? { from: r.key, to: link.to, rels: [] };
        if (pair.rels.length === 0) {
          bump(r.key);
          bump(link.to);
        }
        pair.rels.push(humanize(link.rel));
        pairs.set(id, pair);
      }
    }
    const lines: Line[] = [...pairs.entries()].map(([id, p]) => ({
      id,
      from: p.from,
      to: p.to,
      label: p.rels.join(' · '),
    }));
    const dots: Dot[] = shown.map((r) => ({
      id: r.key,
      record: r,
      collection: r.collection,
      label: recordLabel(r, schemaOf(r.collection)),
      color: colours.get(r.collection) ?? palette.ink.faint,
      r: 5 + Math.min(7, Math.sqrt(degree.get(r.key) ?? 0) * 1.6),
    }));
    if (showPeople) {
      const seen = new Set<string>();
      for (const r of shown) {
        const did = writerOf(r);
        const id = PERSON + did;
        if (!seen.has(did)) {
          seen.add(did);
          dots.push({
            id,
            did,
            collection: '',
            label: nameOf(did, people),
            color: palette.ink.strong,
            r: 11,
          });
        }
        lines.push({ id: `${id}>${r.key}`, from: id, to: r.key, label: 'Wrote' });
      }
    }
    return { dots, lines };
  }, [records, showPeople, people, colours, collections]); // eslint-disable-line react-hooks/exhaustive-deps

  const dotById = useMemo(() => new Map(graph.dots.map((d) => [d.id, d])), [graph]);
  const shape = `${graph.dots.map((d) => d.id).join(',')}|${graph.lines.map((l) => l.id).join(',')}`;

  // The layout loop and its fit run from frames started by earlier renders, so they read the pick from here.
  const selectedRef = useRef(selected);
  useLayoutEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  /** The width left for the map once the panel on the right takes its share */
  const room = () => {
    const box = svgRef.current?.getBoundingClientRect();
    const w = box?.width ?? 0;
    const picked = selectedRef.current;
    if (!box || !picked) return w;
    // A person's panel sits in the map; a record's is the record panel, along the window's right edge.
    const left = picked.startsWith(PERSON) ? w - PANEL - 24 : globalThis.innerWidth - RECORD_PANEL - box.left;
    return Math.max(left, w / 2);
  };

  /** Eases the view to another one */
  const glide = (to: View) => {
    const from = { ...viewRef.current };
    const start = performance.now();
    if (flight.current !== null) cancelAnimationFrame(flight.current);
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 350);
      const e = 1 - Math.pow(1 - t, 3);
      setView({
        x: from.x + (to.x - from.x) * e,
        y: from.y + (to.y - from.y) * e,
        k: from.k + (to.k - from.k) * e,
      });
      flight.current = t < 1 ? requestAnimationFrame(step) : null;
    };
    flight.current = requestAnimationFrame(step);
  };

  /** Glides the view so a dot sits in the middle of what is visible */
  const flyTo = (id: string) => {
    const p = places.current.get(id);
    const box = svgRef.current?.getBoundingClientRect();
    if (!p || !box) return;
    const k = Math.max(viewRef.current.k, 1);
    glide({ k, x: room() / 2 - p.x * k, y: box.height / 2 - p.y * k });
  };

  /** Zooms so everything on screen fits */
  const fit = (animate = true) => {
    const box = svgRef.current?.getBoundingClientRect();
    const ps = sim.current.places;
    if (!box || ps.length === 0) return;
    const xs = ps.map((p) => p.x);
    const ys = ps.map((p) => p.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const w = room();
    const k = clamp(Math.min(w / (x1 - x0 + 80), box.height / (y1 - y0 + 80)), 0.15, 1.6);
    const to = { k, x: w / 2 - ((x0 + x1) / 2) * k, y: box.height / 2 - ((y0 + y1) / 2) * k };
    if (animate) glide(to);
    else setView(to);
  };

  /** Runs the layout until it settles, one or two steps a frame */
  const run = () => {
    if (loop.current !== null) return;
    const frame = () => {
      const h = heat.current;
      const { places: ps, springs } = sim.current;
      for (let i = 0; i < 2; i++) {
        h.alpha += (h.target - h.alpha) * 0.0228;
        tick(ps, springs, h.alpha);
      }
      setDrawn(new Map([...places.current].map(([id, p]) => [id, { x: p.x, y: p.y }])));
      if (!fitted.current && h.alpha < 0.08 && ps.length > 0) {
        fitted.current = true;
        fit(false);
      }
      if (h.alpha > 0.002 || h.target > 0) loop.current = requestAnimationFrame(frame);
      else loop.current = null;
    };
    loop.current = requestAnimationFrame(frame);
  };

  // When the dots or lines change: place new dots near something they touch, and let it all settle again.
  useEffect(() => {
    const { dots, lines } = graph;
    const map = places.current;
    // Dots taken off the map lose their places, so each frame copies only what is drawn.
    const ids = new Set(dots.map((d) => d.id));
    for (const id of map.keys()) if (!ids.has(id)) map.delete(id);
    const known = dots.filter((d) => map.has(d.id)).length;
    const neighbours = new Map<string, string[]>();
    for (const l of lines) {
      neighbours.set(l.from, [...(neighbours.get(l.from) ?? []), l.to]);
      neighbours.set(l.to, [...(neighbours.get(l.to) ?? []), l.from]);
    }
    dots.forEach((d, i) => {
      if (map.has(d.id)) return;
      const anchor = (neighbours.get(d.id) ?? []).map((id) => map.get(id)).find(Boolean);
      const angle = i * 2.39996;
      const reach = anchor ? 24 : 14 * Math.sqrt(i + 0.5);
      map.set(d.id, {
        x: (anchor?.x ?? 0) + Math.cos(angle) * reach,
        y: (anchor?.y ?? 0) + Math.sin(angle) * reach,
        vx: 0,
        vy: 0,
        fx: null,
        fy: null,
      });
    });
    const index = new Map(dots.map((d, i) => [d.id, i]));
    const degree = new Map<string, number>();
    for (const l of lines) {
      degree.set(l.from, (degree.get(l.from) ?? 0) + 1);
      degree.set(l.to, (degree.get(l.to) ?? 0) + 1);
    }
    sim.current = {
      places: dots.map((d) => map.get(d.id)!),
      springs: lines.map((l) => {
        const a = degree.get(l.from) ?? 1;
        const b = degree.get(l.to) ?? 1;
        return {
          s: index.get(l.from)!,
          t: index.get(l.to)!,
          distance: l.from.startsWith(PERSON) ? 70 : 48,
          strength: 1 / Math.min(a, b),
          bias: a / (a + b),
        };
      }),
    };
    heat.current.alpha = known === 0 ? 1 : Math.max(heat.current.alpha, known < dots.length ? 0.4 : 0.15);
    run();
    const fly = pendingFly.current;
    if (fly && map.has(fly)) {
      pendingFly.current = null;
      flyTo(fly);
    }
  }, [shape]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(
    () => () => {
      if (loop.current !== null) cancelAnimationFrame(loop.current);
      if (flight.current !== null) cancelAnimationFrame(flight.current);
    },
    [],
  );

  // The canvas follows its box; the first time it has a size, the middle of the map goes in the middle.
  const hasGraph = counts.length > 0;
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      // The height is set in CSS (shorter on a phone), so it is read here like the width.
      const { width: w, height: h } = entry.contentRect;
      setSize((old) => {
        if (old.w === 0) setView({ x: w / 2, y: h / 2, k: 1 });
        return { w, h };
      });
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [hasGraph]);

  // Scrolling zooms around the pointer. Listened to directly, so the page itself does not scroll.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = svg.getBoundingClientRect();
      const px = event.clientX - box.left;
      const py = event.clientY - box.top;
      const v = viewRef.current;
      const k = clamp(v.k * Math.exp(-event.deltaY * 0.0015), 0.15, 4);
      setView({ k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [hasGraph]);

  /**
   * Picks a dot from the panel and goes to it. A record that is not on the map
   * — its collection not picked, or past the budget — is brought onto it on
   * its own, without the rest of its collection.
   */
  const walkTo = (id: string, record?: NodeRecord) => {
    setSelected(id);
    if (record && !byKey.has(id)) {
      setWalked((old) => [...old.filter((key) => key !== id), id].slice(-WALKED_MAX));
      pendingFly.current = id;
      return;
    }
    if (id.startsWith(PERSON) && !showPeople) {
      setShowPeople(true);
      pendingFly.current = id;
      return;
    }
    flyTo(id);
  };

  // Pointer handling: drag the background to move around, drag a dot to move it, click to pick.
  const local = (event: ReactPointerEvent) => {
    const box = svgRef.current!.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };
  const onBackgroundDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    const at = local(event);
    svgRef.current?.setPointerCapture(event.pointerId);
    if (flight.current !== null) cancelAnimationFrame(flight.current);
    gesture.current = { kind: 'pan', sx: at.x, sy: at.y, view: { ...viewRef.current }, moved: false };
    setDragging('pan');
  };
  const onDotDown = (event: ReactPointerEvent, id: string) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const at = local(event);
    svgRef.current?.setPointerCapture(event.pointerId);
    gesture.current = { kind: 'dot', id, sx: at.x, sy: at.y, moved: false };
    setDragging('dot');
  };
  const onMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    if (!g) return;
    const at = local(event);
    if (!g.moved && Math.hypot(at.x - g.sx, at.y - g.sy) < 4) return;
    if (g.kind === 'pan') {
      g.moved = true;
      setView({ k: g.view.k, x: g.view.x + at.x - g.sx, y: g.view.y + at.y - g.sy });
      return;
    }
    const p = places.current.get(g.id);
    if (!p) return;
    if (!g.moved) {
      g.moved = true;
      heat.current.target = 0.25;
      run();
    }
    const v = viewRef.current;
    p.fx = (at.x - v.x) / v.k;
    p.fy = (at.y - v.y) / v.k;
  };
  const onUp = () => {
    const g = gesture.current;
    gesture.current = null;
    setDragging(null);
    if (!g) return;
    if (g.kind === 'pan') {
      if (!g.moved) setSelected(null);
      return;
    }
    if (g.moved) {
      const p = places.current.get(g.id);
      if (p) {
        p.fx = null;
        p.fy = null;
      }
      heat.current.target = 0;
      run();
    } else {
      setSelected((old) => (old === g.id ? null : g.id));
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setSelected(null);
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, []);

  // A picked dot keeps its neighbours lit and dims the rest.
  const lit = useMemo(() => {
    if (!selected || !dotById.has(selected)) return null;
    const set = new Set([selected]);
    for (const l of graph.lines) {
      if (l.from === selected) set.add(l.to);
      if (l.to === selected) set.add(l.from);
    }
    return set;
  }, [selected, graph, dotById]);

  /** With everything shown, a click isolates one collection; after that, clicks add and remove them */
  const toggle = (name: string) => {
    setBudget(BUDGET);
    setWalked([]);
    fitted.current = false;
    setChosen((old) => {
      if (!old) return new Set([name]);
      const next = new Set(old);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next.size ? next : null;
    });
  };
  const showEverything = () => {
    setBudget(BUDGET);
    setWalked([]);
    fitted.current = false;
    setChosen(null);
  };

  if (records === undefined) return <p style={{ fontSize: 13, color: palette.ink.faint }}>Loading…</p>;

  const header = (
    <header>
      <h2 style={{ ...styles.appTitle, fontSize: 22 }}>Explore</h2>
      <p style={{ fontSize: 13, color: palette.ink.muted, marginTop: 4, lineHeight: 1.6 }}>
        The records in this space, with a line wherever one points at another. Drag to move around, scroll to
        zoom, and click a dot to see what it is and follow its lines.
      </p>
    </header>
  );

  if (!hasGraph) {
    return (
      <section
        aria-label="Explore"
        style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}
      >
        {header}
        <div style={styles.emptyState}>
          Nothing here yet. Once records are added to this space, they show up here — joined by a line
          wherever one points at another.
        </div>
      </section>
    );
  }

  const { k } = view;
  const allLabels = k >= 1.3 || graph.dots.length <= 40;
  const pick = selected ? (dotById.get(selected) ?? null) : null;
  const hover = hovered ? (dotById.get(hovered) ?? null) : null;
  const hoverAt = hover ? drawn.get(hover.id) : undefined;

  return (
    <section aria-label="Explore" style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      {header}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {counts.map(([name, count]) => {
          const off = chosen !== null && !chosen.has(name);
          const picked = chosen?.has(name) ?? false;
          const colour = colours.get(name) ?? palette.ink.faint;
          return (
            <button
              key={name}
              aria-pressed={picked}
              title={
                chosen === null
                  ? 'Show only these'
                  : picked
                    ? 'Take these off the map'
                    : 'Add these to the map'
              }
              onClick={() => toggle(name)}
              style={{
                ...ui.chip,
                opacity: off ? 0.55 : 1,
                ...(picked ? { borderColor: palette.ink.strong, color: palette.ink.strong } : {}),
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 99,
                  background: off ? 'transparent' : colour,
                  border: `1.5px solid ${colour}`,
                  flexShrink: 0,
                }}
              />
              {nameOfCollection(name)}
              <span style={{ color: palette.ink.faint, fontVariantNumeric: 'tabular-nums' }}>{count}</span>
            </button>
          );
        })}
        {chosen !== null && (
          <button onClick={showEverything} style={{ ...ui.chip, color: palette.ink.muted }}>
            Show everything
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button
          aria-pressed={showPeople}
          onClick={() => setShowPeople((v) => !v)}
          style={{ ...ui.chip, ...(showPeople ? ui.chipOn : {}) }}
        >
          Show people
        </button>
        <button onClick={() => fit()} style={ui.chip}>
          Fit to screen
        </button>
      </div>

      <p style={{ fontSize: 12.5, color: palette.ink.muted, margin: '-6px 0 0', lineHeight: 1.6 }}>
        {chosen === null
          ? 'Click a collection to see only it, then click others to add them.'
          : `Showing ${chosen.size} of ${counts.length} collections.`}
        {records !== undefined && loadedCount < total && (
          <>
            {' '}
            The newest {loadedCount} of {total} records are on the map, to keep it quick
            {budget < BUDGET_MAX ? ' — ' : '.'}
            {budget < BUDGET_MAX && (
              <button
                onClick={() => setBudget((b) => Math.min(BUDGET_MAX, b + BUDGET_STEP))}
                style={{ ...plain, color: palette.ink.strong, textDecoration: 'underline', fontSize: 12.5 }}
              >
                show more
              </button>
            )}
            {budget >= BUDGET_MAX && chosen === null && ' Pick collections to see more of each.'}
          </>
        )}
      </p>

      <div
        ref={wrapRef}
        className="graph-canvas"
        style={{
          position: 'relative',
          border: `1px solid ${palette.surface.line}`,
          borderRadius: palette.radius.lg,
          background: palette.surface.sunken,
          overflow: 'hidden',
        }}
      >
        <svg
          ref={svgRef}
          width="100%"
          height="100%"
          role="img"
          aria-label={`A map of ${graph.dots.length} records in ${space.name} and how they connect`}
          onPointerDown={onBackgroundDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          style={{
            display: 'block',
            touchAction: 'none',
            cursor: dragging === 'pan' ? 'grabbing' : 'grab',
            userSelect: 'none',
          }}
        >
          <defs>
            {(['base', 'lit'] as const).map((tone) => (
              <marker
                key={tone}
                id={`${uid}-${tone}`}
                viewBox="0 0 10 10"
                refX={9}
                refY={5}
                markerWidth={6}
                markerHeight={6}
                orient="auto-start-reverse"
              >
                <path
                  d="M0,1 L9,5 L0,9 z"
                  fill={tone === 'lit' ? palette.ink.body : palette.surface.lineStrong}
                />
              </marker>
            ))}
          </defs>
          <g transform={`translate(${view.x},${view.y}) scale(${k})`}>
            {graph.lines.map((l) => {
              const a = drawn.get(l.from);
              const b = drawn.get(l.to);
              const da = dotById.get(l.from);
              const db = dotById.get(l.to);
              if (!a || !b || !da || !db) return null;
              const dx = b.x - a.x;
              const dy = b.y - a.y;
              const d = Math.hypot(dx, dy) || 1;
              const on = !!lit && (l.from === selected || l.to === selected);
              const dim = !!lit && !on;
              const x1 = a.x + (dx / d) * da.r;
              const y1 = a.y + (dy / d) * da.r;
              const x2 = b.x - (dx / d) * (db.r + 2);
              const y2 = b.y - (dy / d) * (db.r + 2);
              return (
                <g key={l.id} opacity={dim ? 0.12 : 1}>
                  <line
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    stroke={on ? palette.ink.body : palette.surface.lineStrong}
                    strokeWidth={(on ? 1.4 : 1) / Math.max(k, 0.6)}
                    strokeDasharray={l.from.startsWith(PERSON) ? `${3 / k} ${3 / k}` : undefined}
                    markerEnd={`url(#${uid}-${on ? 'lit' : 'base'})`}
                  />
                  {(on || (!lit && k >= 1.8)) && (
                    <text
                      x={(x1 + x2) / 2}
                      y={(y1 + y2) / 2}
                      textAnchor="middle"
                      dy={-3 / k}
                      fontSize={10 / k}
                      fill={on ? palette.ink.body : palette.ink.faint}
                      stroke={palette.surface.sunken}
                      strokeWidth={3 / k}
                      paintOrder="stroke"
                      style={{ pointerEvents: 'none' }}
                    >
                      {l.label}
                    </text>
                  )}
                </g>
              );
            })}
            {graph.dots.map((dot) => {
              const p = drawn.get(dot.id);
              if (!p) return null;
              const isPicked = dot.id === selected;
              const dim = !!lit && !lit.has(dot.id);
              const showLabel =
                isPicked || dot.id === hovered || (lit ? lit.has(dot.id) : allLabels || !!dot.did);
              return (
                <g
                  key={dot.id}
                  transform={`translate(${p.x},${p.y})`}
                  opacity={dim ? 0.15 : 1}
                  onPointerDown={(e) => onDotDown(e, dot.id)}
                  onPointerEnter={() => setHovered(dot.id)}
                  onPointerLeave={() => setHovered((h) => (h === dot.id ? null : h))}
                  style={{ cursor: 'pointer' }}
                >
                  {isPicked && (
                    <circle
                      r={dot.r + 4}
                      fill="none"
                      stroke={palette.ink.strong}
                      strokeWidth={1.5 / Math.max(k, 0.6)}
                    />
                  )}
                  {dot.did ? (
                    <g transform={`translate(${-dot.r},${-dot.r})`}>
                      <rect
                        width={dot.r * 2}
                        height={dot.r * 2}
                        rx={dot.r / 2}
                        fill={palette.surface.card}
                        stroke={palette.ink.strong}
                        strokeWidth={1}
                      />
                      <g transform="translate(2,2)">
                        <Avatar did={dot.did} size={dot.r * 2 - 4} />
                      </g>
                    </g>
                  ) : (
                    <circle
                      r={dot.r}
                      fill={dot.record?.body === null ? palette.surface.card : dot.color}
                      stroke={dot.record?.body === null ? dot.color : palette.surface.card}
                      strokeWidth={1.5}
                    />
                  )}
                  {showLabel && (
                    <text
                      x={dot.r + 5 / k}
                      dy="0.35em"
                      fontSize={11 / k}
                      fontWeight={isPicked ? 600 : 400}
                      fill={palette.ink.body}
                      stroke={palette.surface.sunken}
                      strokeWidth={3 / k}
                      paintOrder="stroke"
                      style={{ pointerEvents: 'none' }}
                    >
                      {short(dot.label)}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>

        {hover && hoverAt && hover.record && !dragging && (
          <div
            style={{
              ...tooltip,
              left: clamp(view.x + hoverAt.x * k + 14, 8, Math.max(8, size.w - 240)),
              top: clamp(view.y + hoverAt.y * k + 14, 8, size.h - 70),
            }}
          >
            <div style={{ fontWeight: 600, color: palette.ink.strong }}>{short(hover.label, 60)}</div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                marginTop: 4,
                color: palette.ink.muted,
              }}
            >
              <Avatar did={writerOf(hover.record)} size={14} />
              {nameOf(writerOf(hover.record), people)} · {nameOfCollection(hover.collection)} ·{' '}
              {ago(hover.record.createdAt)}
            </div>
          </div>
        )}

        {pick?.did && (
          <Details
            did={pick.did}
            label={pick.label}
            records={all}
            colourOf={(name) => colours.get(name) ?? palette.ink.faint}
            collectionName={nameOfCollection}
            labelOf={(r) => recordLabel(r, schemaOf(r.collection))}
            onWalk={walkTo}
            onClose={() => setSelected(null)}
          />
        )}
        {pick?.record && (
          <RecordPanel
            space={space}
            recordKey={pick.id}
            collections={collections}
            scrim={false}
            onOpen={(r) => walkTo(r.key, r)}
            onWriter={(did) => walkTo(PERSON + did)}
            onClose={() => setSelected(null)}
          />
        )}

        {!pick && (
          <p
            style={{
              position: 'absolute',
              left: 12,
              bottom: 10,
              fontSize: 12,
              color: palette.ink.faint,
              pointerEvents: 'none',
            }}
          >
            {graph.dots.length} {graph.dots.length === 1 ? 'record' : 'records'} · {graph.lines.length}{' '}
            {graph.lines.length === 1 ? 'line' : 'lines'}
          </p>
        )}
      </div>
    </section>
  );
}

/** A picked person: what they wrote on the map, each a step further along. */
function Details({
  did,
  label,
  records,
  colourOf,
  collectionName,
  labelOf,
  onWalk,
  onClose,
}: {
  did: string;
  label: string;
  records: ReadonlyArray<NodeRecord>;
  colourOf: (collection: string) => string;
  collectionName: (collection: string) => string;
  labelOf: (record: NodeRecord) => string;
  onWalk: (id: string, record?: NodeRecord) => void;
  onClose: () => void;
}) {
  const wrote = records.filter((r) => writerOf(r) === did);
  return (
    <aside aria-label={label} style={panel}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 12px 10px 16px',
          borderBottom: `1px solid ${palette.surface.line}`,
          fontSize: 12.5,
          color: palette.ink.muted,
        }}
      >
        Person
        <button onClick={onClose} aria-label="Close" style={{ ...styles.rowAction, fontSize: 13 }}>
          ✕
        </button>
      </header>
      <div style={panelBody}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Avatar did={did} size={32} />
          <div>
            <h3
              style={{ fontSize: 16, fontWeight: 600, color: palette.ink.strong, letterSpacing: '-0.02em' }}
            >
              <Person did={did} />
            </h3>
            <p style={{ fontSize: 12, color: palette.ink.faint }}>
              Wrote {wrote.length} {wrote.length === 1 ? 'record' : 'records'} on the map
            </p>
          </div>
        </div>
        <Group title="Wrote">
          {wrote.map((r) => (
            <li key={r.key}>
              <button
                onClick={() => onWalk(r.key, r)}
                data-row
                style={{ ...styles.row, padding: '7px 8px', gap: 8, alignItems: 'flex-start' }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    marginTop: 5,
                    borderRadius: 99,
                    flexShrink: 0,
                    background: colourOf(r.collection),
                  }}
                />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ ...ui.ellipsis, display: 'block', fontSize: 13, color: palette.ink.strong }}>
                    {labelOf(r)}
                  </span>
                  <span style={{ display: 'block', fontSize: 11.5, color: palette.ink.faint }}>
                    {collectionName(r.collection)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </Group>
      </div>
    </aside>
  );
}

function Group({ title, children }: { title: string; children: ReadonlyArray<ReactElement> }) {
  return (
    <div>
      <h4 style={{ margin: '0 0 4px', fontSize: 12, fontWeight: 600, color: palette.ink.muted }}>
        {title}
        {children.length > 0 && (
          <span style={{ color: palette.ink.faint, fontWeight: 400 }}> · {children.length}</span>
        )}
      </h4>
      {children.length > 0 && <ul style={{ listStyle: 'none', margin: '0 -8px' }}>{children}</ul>}
    </div>
  );
}

const plain: CSSProperties = {
  border: 'none',
  background: 'none',
  padding: 0,
  font: 'inherit',
  color: 'inherit',
};
const tooltip: CSSProperties = {
  position: 'absolute',
  maxWidth: 240,
  padding: '8px 10px',
  borderRadius: palette.radius.md,
  background: palette.surface.card,
  border: `1px solid ${palette.surface.line}`,
  boxShadow: '0 8px 20px -12px rgba(15, 17, 21, .25)',
  fontSize: 12,
  lineHeight: 1.4,
  pointerEvents: 'none',
  zIndex: 2,
};
const panel: CSSProperties = {
  position: 'absolute',
  top: 12,
  right: 12,
  bottom: 12,
  width: `min(${PANEL}px, calc(100% - 24px))`,
  display: 'flex',
  flexDirection: 'column',
  background: palette.surface.card,
  border: `1px solid ${palette.surface.line}`,
  borderRadius: palette.radius.lg,
  boxShadow: '0 12px 28px -16px rgba(15, 17, 21, .25)',
  animation: 'weave-fade .12s ease',
  zIndex: 3,
};
const panelBody: CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 18,
};
