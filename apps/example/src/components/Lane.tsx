import type { ComponentProps, ReactNode } from 'react';
import { palette } from '../styles';

/** A board's column: its name and count over its cards; whoever moves cards brings the drop handlers */
export function Lane({
  name,
  count,
  over = false,
  style,
  children,
  ...rest
}: ComponentProps<'section'> & { name: ReactNode; count: number; over?: boolean }) {
  return (
    <section
      {...rest}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: 8,
        borderRadius: 10,
        background: over ? '#f0f0f0' : palette.surface.sunken,
        border: `1px solid ${palette.surface.line}`,
        ...style,
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '2px 4px 6px',
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        {name}
        <span style={{ fontSize: 12, fontWeight: 400, color: palette.ink.faint }}>{count}</span>
      </header>
      {children}
    </section>
  );
}

/** A card on a board, opened by a click and moved by dragging */
export function Card({ style, ...rest }: ComponentProps<'button'>) {
  return (
    <button
      type="button"
      {...rest}
      style={{
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '10px 12px',
        border: `1px solid ${palette.surface.line}`,
        borderRadius: 8,
        background: palette.surface.card,
        font: 'inherit',
        fontSize: 14,
        lineHeight: 1.4,
        color: palette.ink.body,
        textAlign: 'left',
        wordBreak: 'break-word',
        cursor: rest.draggable ? 'grab' : 'pointer',
        ...style,
      }}
    />
  );
}
