import { useEffect, useRef } from 'react';

/**
 * Behind the front page's hero: devices drifting, joined to whoever is near,
 * with no centre. Now and then one of them makes a change, and it spreads hop
 * by hop to every device it can reach, which is how sync works. A 2D canvas,
 * because a few dots and lines don't need a 3D library.
 */

interface Dot {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** One change spreading: when it left, and when it reached each dot (hops × HOP) */
interface Wave {
  readonly start: number;
  readonly reached: ReadonlyMap<number, number>;
  readonly from: ReadonlyMap<number, number>;
}

const HOP = 260; // ms for a change to cross one link
const GLOW = 900; // ms a dot stays lit once the change reaches it
const EVERY = 2600; // ms between changes
const SPEED = 0.012; // px per ms of drift

export function HeroMesh() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    let width = 0;
    let height = 0;
    let reach = 0;
    let dots: Dot[] = [];
    let waves: Wave[] = [];
    let lastWave = -Infinity;
    let frame = 0;
    let visible = true;

    const place = () => {
      const ratio = globalThis.devicePixelRatio || 1;
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      reach = Math.max(130, Math.min(190, width / 7));
      const count = Math.round(Math.min(90, Math.max(30, (width * height) / 11000)));
      dots = Array.from({ length: count }, () => {
        const angle = Math.random() * Math.PI * 2;
        return { x: Math.random() * width, y: Math.random() * height, vx: Math.cos(angle) * SPEED, vy: Math.sin(angle) * SPEED };
      });
      waves = [];
    };

    const near = (a: Dot, b: Dot) => Math.hypot(a.x - b.x, a.y - b.y) < reach;

    /** Breadth first from one dot, over the links as they are right now */
    const spread = (now: number): Wave => {
      const origin = Math.floor(Math.random() * dots.length);
      const reached = new Map([[origin, now]]);
      const from = new Map<number, number>();
      let edge = [origin];
      for (let hop = 1; edge.length; hop++) {
        const next: number[] = [];
        for (const i of edge) {
          const here = dots[i];
          if (!here) continue;
          dots.forEach((dot, j) => {
            if (reached.has(j) || !near(here, dot)) return;
            reached.set(j, now + hop * HOP);
            from.set(j, i);
            next.push(j);
          });
        }
        edge = next;
      }
      return { start: now, reached, from };
    };

    const draw = (now: number, dt: number) => {
      ctx.clearRect(0, 0, width, height);
      for (const dot of dots) {
        dot.x += dot.vx * dt;
        dot.y += dot.vy * dt;
        if (dot.x < 0 || dot.x > width) dot.vx *= -1;
        if (dot.y < 0 || dot.y > height) dot.vy *= -1;
      }

      ctx.lineWidth = 1;
      dots.forEach((a, i) => {
        for (const b of dots.slice(i + 1)) {
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d >= reach) continue;
          ctx.strokeStyle = `rgba(0,0,0,${0.07 * (1 - d / reach)})`;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      });

      // How lit each dot is, and the change travelling along each link
      const lit = dots.map(() => 0);
      for (const wave of waves) {
        for (const [j, at] of wave.reached) {
          const since = now - at;
          if (since >= 0 && since < GLOW) lit[j] = Math.max(lit[j] ?? 0, 1 - since / GLOW);
          const to = dots[j];
          const source = dots[wave.from.get(j) ?? -1];
          if (!to || !source || since >= 0 || since < -HOP) continue;
          const t = 1 + since / HOP;
          ctx.strokeStyle = 'rgba(0,0,0,0.22)';
          ctx.beginPath();
          ctx.moveTo(source.x, source.y);
          ctx.lineTo(source.x + (to.x - source.x) * t, source.y + (to.y - source.y) * t);
          ctx.stroke();
        }
      }

      dots.forEach((dot, i) => {
        const glow = lit[i] ?? 0;
        ctx.fillStyle = `rgba(0,0,0,${0.16 + 0.5 * glow})`;
        ctx.beginPath();
        ctx.arc(dot.x, dot.y, 2 + 1.5 * glow, 0, Math.PI * 2);
        ctx.fill();
      });
    };

    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      if (now - lastWave > EVERY) {
        waves.push(spread(now));
        lastWave = now;
      }
      waves = waves.filter((wave) => Math.max(...wave.reached.values()) + GLOW > now);
      draw(now, dt);
      frame = visible ? requestAnimationFrame(tick) : 0;
    };

    place();
    if (still) {
      draw(performance.now(), 0);
    } else {
      frame = requestAnimationFrame(tick);
    }

    const resized = new ResizeObserver(() => {
      place();
      if (still) draw(performance.now(), 0);
    });
    resized.observe(canvas);

    // Nothing to draw while the hero is scrolled away
    const seen = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      if (visible && !still && !frame) {
        last = performance.now();
        frame = requestAnimationFrame(tick);
      }
    });
    seen.observe(canvas);

    return () => {
      cancelAnimationFrame(frame);
      resized.disconnect();
      seen.disconnect();
    };
  }, []);

  return <canvas ref={ref} className="mesh" aria-hidden />;
}
