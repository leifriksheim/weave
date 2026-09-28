import { Icon, type IconName } from '../Icon';

/** An app's glyph on its own tint, the same wherever the app appears */
export function AppIcon({
  icon,
  hue,
  size,
  className,
}: {
  icon: IconName;
  hue: number;
  size: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={className}
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: Math.round(size * 0.28),
        background: `linear-gradient(145deg, hsl(${hue} 80% 62%), hsl(${(hue + 25) % 360} 70% 46%))`,
        color: '#fff',
      }}
    >
      <Icon name={icon} size={Math.round(size * 0.52)} />
    </span>
  );
}

/** How many new things there are, on a corner or at the end of a row; nothing when there are none */
export function Count({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span className="count" aria-label={`${n} new`}>
      {n > 99 ? '99+' : n}
    </span>
  );
}
