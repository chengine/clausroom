interface WordmarkProps {
  size?: 'sm' | 'lg';
}

export function Wordmark({ size = 'sm' }: WordmarkProps) {
  return (
    <span className={`wordmark wordmark--${size}`}>
      <svg
        className="wordmark__glyph"
        viewBox="0 0 32 32"
        width={size === 'lg' ? 34 : 22}
        height={size === 'lg' ? 34 : 22}
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="wm-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#8b5cf6" />
            <stop offset="1" stopColor="#38bdf8" />
          </linearGradient>
        </defs>
        <rect x="2" y="4" width="28" height="20" rx="7" fill="url(#wm-grad)" />
        <path d="M10 24 L10 30 L17 24 Z" fill="url(#wm-grad)" />
        <circle cx="11" cy="14" r="2.4" fill="#0b0f1a" />
        <circle cx="21" cy="14" r="2.4" fill="#0b0f1a" />
      </svg>
      <span className="wordmark__text">clausroom</span>
    </span>
  );
}
