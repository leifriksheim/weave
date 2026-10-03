import type { CSSProperties, ReactNode } from 'react';
import { palette } from '../styles';

const REPO = 'https://github.com/leifriksheim/weave/blob/main/';

/** A line on what is going on underneath, and the page that explains the rest */
export function DocsNote({
  path,
  style,
  children,
}: {
  path: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <p style={{ fontSize: 13, color: palette.ink.muted, lineHeight: 1.6, margin: 0, ...style }}>
      {children}{' '}
      <a href={REPO + path} target="_blank" rel="noreferrer" style={{ color: palette.ink.body }}>
        How it works
      </a>
    </p>
  );
}
