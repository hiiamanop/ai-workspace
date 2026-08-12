import { Fragment, useState, type ReactNode } from 'react'

/**
 * Minimal dependency-free markdown for chat bubbles: paragraphs, ul/ol,
 * headings, **bold**, *italic*, `inline code`. Tolerates
 * partial (streaming) input — anything unrecognized renders as plain text.
 */

const INLINE_RE = /(`[^`\n]+`|\*\*[^*\n]+?\*\*|\*[^*\n]+?\*)/g

export interface MarkdownCitation {
  title: string
  url: string
  snippet?: string
  publishedDate?: string
}

function faviconUrl(pageUrl: string): string {
  try {
    return `https://www.google.com/s2/favicons?sz=32&domain=${new URL(pageUrl).hostname}`
  } catch {
    return ''
  }
}

function CitationChip({ citation }: { citation: MarkdownCitation }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  let hostname = ''
  try {
    hostname = new URL(citation.url).hostname
  } catch {
    /* leave hostname blank if the URL doesn't parse */
  }
  const favicon = faviconUrl(citation.url)
  return (
    <span className="ai-cite-wrap">
      <sup
        className="ai-cite"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        {favicon && <img src={favicon} alt="" className="ai-cite-fav" />}
      </sup>
      {open && (
        <>
          <span className="ai-cite-overlay" onClick={() => setOpen(false)} />
          <span className="ai-cite-card">
            <span className="ai-cite-source">{hostname}</span>
            <a href={citation.url} target="_blank" rel="noopener noreferrer" className="ai-cite-title">
              {citation.title}
            </a>
            {citation.publishedDate && <span className="ai-cite-date">{citation.publishedDate}</span>}
          </span>
        </>
      )}
    </span>
  )
}

const INLINE_WITH_CITE_RE = /(`[^`\n]+`|\*\*[^*\n]+?\*\*|\*[^*\n]+?\*|\[\d+\])/g

function renderInline(text: string, citations?: MarkdownCitation[]): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let key = 0
  const re = citations && citations.length > 0 ? INLINE_WITH_CITE_RE : INLINE_RE
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0
    if (i > last) out.push(text.slice(last, i))
    const tok = m[0] ?? ''
    if (tok.startsWith('`')) out.push(<code key={key++}>{tok.slice(1, -1)}</code>)
    else if (tok.startsWith('**')) out.push(<strong key={key++}>{tok.slice(2, -2)}</strong>)
    else if (tok.startsWith('*')) out.push(<em key={key++}>{tok.slice(1, -1)}</em>)
    else {
      const n = Number(tok.slice(1, -1))
      const citation = citations?.[n - 1]
      out.push(citation ? <CitationChip key={key++} citation={citation} /> : tok)
    }
    last = i + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

type MdBlock =
  | { kind: 'p'; lines: string[] }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'h'; text: string }

function parseBlocks(text: string): MdBlock[] {
  const blocks: MdBlock[] = []
  let cur: MdBlock | null = null
  const flush = (): void => {
    if (cur) {
      blocks.push(cur)
      cur = null
    }
  }
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (!line.trim()) {
      flush()
      continue
    }
    const h = /^#{1,6}\s+(.*)$/.exec(line)
    if (h) {
      flush()
      blocks.push({ kind: 'h', text: h[1] ?? '' })
      continue
    }
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line)
    if (ul) {
      if (cur?.kind !== 'ul') {
        flush()
        cur = { kind: 'ul', items: [] }
      }
      cur.items.push(ul[1] ?? '')
      continue
    }
    const ol = /^\s*\d+[.、)]\s+(.*)$/.exec(line)
    if (ol) {
      if (cur?.kind !== 'ol') {
        flush()
        cur = { kind: 'ol', items: [] }
      }
      cur.items.push(ol[1] ?? '')
      continue
    }
    if (cur?.kind !== 'p') {
      flush()
      cur = { kind: 'p', lines: [] }
    }
    cur.lines.push(line)
  }
  flush()
  return blocks
}

export function Markdown({ text, citations }: { text: string; citations?: MarkdownCitation[] }): React.JSX.Element {
  return (
    <div className="ai-md">
      {parseBlocks(text).map((b, i) => {
        if (b.kind === 'h') {
          return (
            <p key={i} className="ai-md-h">
              {renderInline(b.text, citations)}
            </p>
          )
        }
        if (b.kind === 'ul' || b.kind === 'ol') {
          const items = b.items.map((it, j) => <li key={j}>{renderInline(it, citations)}</li>)
          return b.kind === 'ul' ? <ul key={i}>{items}</ul> : <ol key={i}>{items}</ol>
        }
        return (
          <p key={i}>
            {b.lines.map((ln, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {renderInline(ln, citations)}
              </Fragment>
            ))}
          </p>
        )
      })}
    </div>
  )
}
