import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Markdown body renderer. Raw HTML is intentionally NOT rendered (no
 * rehype-raw, no dangerouslySetInnerHTML) — room content is untrusted input.
 * Links open in a new tab with rel=noopener.
 */
export function Markdown({ source }: { source: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer" />
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
