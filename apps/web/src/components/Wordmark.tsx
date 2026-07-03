interface WordmarkProps {
  size?: 'sm' | 'lg';
}

export function Wordmark({ size = 'sm' }: WordmarkProps) {
  const px = size === 'lg' ? 36 : 24;
  return (
    <span className={`wordmark wordmark--${size}`}>
      <img
        className="wordmark__glyph"
        src="/claus.png"
        width={px}
        height={px}
        alt=""
        aria-hidden="true"
        style={{ imageRendering: 'pixelated', objectFit: 'contain' }}
      />
      <span className="wordmark__text">clausroom</span>
    </span>
  );
}
