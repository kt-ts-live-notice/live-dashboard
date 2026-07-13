import { useEffect, useRef, useState } from 'react'

type Severity = '일반' | '주의' | '긴급'

interface Announcement {
  id: number
  original: string
  simplified: string
  category: string
  severity: Severity
  latencyMs: number
  ts: number
}

interface ServerEvent {
  type: 'stt-interim' | 'stt-final' | 'announcement' | 'filtered' | 'status'
  [key: string]: unknown
}

const CATEGORY_ICONS: Record<string, string> = {
  지연: '⏱️',
  무정차: '🚫',
  승강장변경: '↔️',
  안전: '⚠️',
  긴급: '🚨',
  일반: 'ℹ️',
}

export default function App() {
  const [announcements, setAnnouncements] = useState<Announcement[]>([])
  const [interim, setInterim] = useState('')
  const [playing, setPlaying] = useState<string | null>(null)
  const [samples, setSamples] = useState<string[]>([])
  const [connected, setConnected] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    fetch('/api/samples')
      .then((r) => r.json())
      .then((d) => {
        setSamples(d.samples)
        setPlaying(d.playing)
      })
      .catch(() => {})

    let closed = false
    function connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${proto}://${location.host}/ws`)
      wsRef.current = ws
      ws.onopen = () => setConnected(true)
      ws.onclose = () => {
        setConnected(false)
        if (!closed) setTimeout(connect, 1500)
      }
      ws.onmessage = (e) => {
        const ev: ServerEvent = JSON.parse(e.data)
        if (ev.type === 'stt-interim') setInterim(ev.text as string)
        if (ev.type === 'stt-final') setInterim('')
        if (ev.type === 'status') setPlaying(ev.playing as string | null)
        if (ev.type === 'announcement') {
          setAnnouncements((prev) => [ev as unknown as Announcement, ...prev])
        }
      }
    }
    connect()
    return () => {
      closed = true
      wsRef.current?.close()
    }
  }, [])

  const play = (name: string) => {
    fetch(`/api/play/${name}`, { method: 'POST' }).catch(() => {})
  }

  return (
    <div className="app">
      <header>
        <h1>🚉 역사 안내방송 알리미</h1>
        <span className={connected ? 'conn ok' : 'conn'}>{connected ? '연결됨' : '연결 끊김'}</span>
      </header>

      <main>
        {announcements.length === 0 && (
          <p className="empty">아직 안내방송이 없습니다.</p>
        )}
        {announcements.map((a) => (
          <article key={`${a.ts}-${a.id}`} className={`card sev-${a.severity}`}>
            <div className="card-head">
              <span className="tag">
                {CATEGORY_ICONS[a.category] ?? 'ℹ️'} {a.category}
              </span>
              <span className={`tag sev-tag-${a.severity}`}>{a.severity}</span>
              <time>{new Date(a.ts).toLocaleTimeString('ko-KR')}</time>
            </div>
            <p className="simplified">{a.simplified}</p>
            <details>
              <summary>원문 보기</summary>
              <p className="original">{a.original}</p>
              <p className="meta">처리 지연 {a.latencyMs}ms</p>
            </details>
          </article>
        ))}
      </main>

      <footer>
        <div className="ticker" aria-hidden="true">
          {interim ? `🎤 ${interim}` : playing ? `▶️ ${playing} 재생 중…` : ''}
        </div>
        <div className="panel">
          {samples.map((s) => (
            <button key={s} onClick={() => play(s)} disabled={playing !== null}>
              {s}
            </button>
          ))}
        </div>
      </footer>
    </div>
  )
}
