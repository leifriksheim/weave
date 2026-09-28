import { Icon, type IconName } from '../Icon';
import type { Unread } from '../../seen';

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

const upTo99 = (n: number) => (n > 99 ? '99+' : String(n));

/**
 * What is new, on a corner or at the end of a row; nothing when there is
 * nothing. Red with an @ when some of it names you, the way chat apps mark
 * mentions; quiet grey when it is only new.
 */
export function Count({ unread }: { unread: Unread }) {
  if (unread.count <= 0) return null;
  if (unread.forMe > 0)
    return (
      <span className="count" aria-label={`${unread.forMe} for you, ${unread.count} new`}>
        @{upTo99(unread.forMe)}
      </span>
    );
  return (
    <span className="count" data-quiet aria-label={`${unread.count} new`}>
      {upTo99(unread.count)}
    </span>
  );
}
