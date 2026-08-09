import { useEffect, useRef, useState } from 'react'
import { resolveStationPage, type StationPageContext } from './stationRoute'

type Severity = '일반' | '주의' | '긴급'

interface Announcement {
  id?: number
  original: string
  simplified: string
  category: string
  severity: Severity
  latencyMs: number
  ts: number
  device_id?: string
  session_id?: string
  display?: {
    conclusion: string
    support?: string
  }
}

interface ServerEvent {
  type: 'stt-interim' | 'stt-final' | 'announcement' | 'filtered' | 'status' | 'session-error'
  [key: string]: unknown
}

const SEVERITY_INFO: Record<Severity, { symbol: string }> = {
  일반: { symbol: 'i' },
  주의: { symbol: '▲' },
  긴급: { symbol: '!' },
}

function textLengthClass(text: string): 'copy-short' | 'copy-medium' | 'copy-long' {
  const length = [...text].length
  if (length <= 34) return 'copy-short'
  if (length <= 66) return 'copy-medium'
  return 'copy-long'
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
}

function previewAnnouncements(stationId: string, enabled: boolean): Announcement[] {
  if (!enabled) return []
  const now = Date.now()
  return [
    {
      id: -1,
      original: '지금 들어오는 열차는 우리 역을 통과하는 열차입니다.',
      simplified: '지금 들어오는 열차는 영등포역에 정차하지 않습니다. 안전선 안으로 이동하세요.',
      category: '열차 통과', severity: '긴급', latencyMs: 1320, ts: now, device_id: stationId,
      display: { conclusion: '정차하지\n않습니다', support: '안전선 안으로 이동하세요' },
    },
    {
      id: -2,
      original: '지금 인천, 인천행 열차가 들어오고 있습니다. 이 역은 승강장과 열차 사이가 넓으니 내리고 타실 때 조심하시기 바랍니다.',
      simplified: '인천행 열차가 들어오고 있습니다. 승강장과 열차 사이가 넓습니다.',
      category: '열차 진입', severity: '주의', latencyMs: 1480, ts: now - 3 * 60_000, device_id: stationId,
      display: { conclusion: '열차가\n들어옵니다', support: '승강장과 열차 사이가 넓습니다' },
    },
    {
      id: -3,
      original: '전동킥보드, 전기자전거, 전동휠 등 리튬배터리로 구동되는 이동수단은 역사와 열차 내 반입을 제한합니다.',
      simplified: '전동킥보드 등 리튬배터리 이동수단은 역사와 열차에 반입할 수 없습니다.',
      category: '반입 제한', severity: '일반', latencyMs: 1570, ts: now - 8 * 60_000, device_id: stationId,
      display: { conclusion: '반입이\n제한됩니다', support: '전동킥보드 · 전기자전거 · 전동휠' },
    },
  ]
}

function SituationBadge({ announcement }: { announcement: Announcement }) {
  const info = SEVERITY_INFO[announcement.severity]
  return (
    <div className="severity-badge" aria-label={`${announcement.category}, 중요도 ${announcement.severity}`}>
      <span className="severity-symbol" aria-hidden="true">{info.symbol}</span>
      <span className="severity-copy">
        <strong>{announcement.category}</strong>
      </span>
    </div>
  )
}

function FocusAnnouncement({ announcement, showTechnical }: { announcement: Announcement; showTechnical: boolean }) {
  const source = [announcement.device_id, announcement.session_id].filter(Boolean).join(' · ')
  return (
    <article
      className="focus-announcement"
      data-severity={announcement.severity}
      aria-live={announcement.severity === '긴급' ? 'assertive' : 'polite'}
      aria-atomic="true"
    >
      <div className="focus-head">
        <SituationBadge announcement={announcement} />
        <div className="focus-meta">
          <time dateTime={new Date(announcement.ts).toISOString()}>{formatTime(announcement.ts)}</time>
        </div>
      </div>

      {announcement.display ? (
        <div className="dynamic-caption">
          <p className="dynamic-conclusion">{announcement.display.conclusion}</p>
          {announcement.display.support && <p className="dynamic-support">{announcement.display.support}</p>}
        </div>
      ) : (
        <p className={`focus-message ${textLengthClass(announcement.simplified)}`}>{announcement.simplified}</p>
      )}

      <details className="original-details">
        <summary>방송 원문 확인</summary>
        <p className="original">{announcement.original}</p>
        {showTechnical && (
          <p className="technical-meta">처리 {announcement.latencyMs.toLocaleString('ko-KR')}ms{source ? ` · ${source}` : ''}</p>
        )}
      </details>
    </article>
  )
}

function InvalidStationPage() {
  return (
    <main className="invalid-page">
      <span className="invalid-icon" aria-hidden="true">QR</span>
      <h1>안내 페이지를<br />열 수 없습니다</h1>
      <p>역에 설치된 QR 코드를 다시 스캔해 주세요.</p>
      <button type="button" onClick={() => location.reload()}>다시 확인</button>
    </main>
  )
}

function WaitingPanel({ stationName }: { stationName: string }) {
  return (
    <section className="waiting-panel" aria-live="polite">
      <span className="waiting-mark" aria-hidden="true">···</span>
      <h2>{stationName} 방송을<br />기다리고 있습니다</h2>
    </section>
  )
}

function StationPage({ station }: { station: StationPageContext }) {
  const [previewItems] = useState<Announcement[]>(() => previewAnnouncements(station.id, station.previewAll))
  const [previewIndex, setPreviewIndex] = useState(0)
  const [announcements, setAnnouncements] = useState<Announcement[]>([])
  const [interim, setInterim] = useState('')
  const [playing, setPlaying] = useState<string | null>(null)
  const [samples, setSamples] = useState<string[]>([])
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    document.title = `${station.name} 안내방송`
    if (station.showDeveloperTools) {
      fetch('/api/samples')
        .then((response) => response.json())
        .then((data: { samples?: unknown; playing?: unknown }) => {
          if (Array.isArray(data.samples)) setSamples(data.samples.filter((sample): sample is string => typeof sample === 'string'))
          setPlaying(typeof data.playing === 'string' ? data.playing : null)
        })
        .catch(() => undefined)
    }

    let closed = false
    function connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${proto}://${location.host}/ws?station_id=${encodeURIComponent(station.id)}`)
      wsRef.current = ws
      ws.onclose = () => {
        if (!closed) setTimeout(connect, 1500)
      }
      ws.onmessage = (event) => {
        let serverEvent: ServerEvent
        try {
          serverEvent = JSON.parse(event.data) as ServerEvent
        } catch {
          return
        }
        if (typeof serverEvent.device_id === 'string' && serverEvent.device_id !== station.id) return
        if (serverEvent.type === 'stt-interim') setInterim(String(serverEvent.text ?? ''))
        if (serverEvent.type === 'stt-final') setInterim('')
        if (serverEvent.type === 'status') setPlaying(typeof serverEvent.playing === 'string' ? serverEvent.playing : null)
        if (serverEvent.type === 'announcement') {
          setAnnouncements((previous) => [serverEvent as unknown as Announcement, ...previous].slice(0, 20))
        }
      }
    }
    connect()
    return () => {
      closed = true
      wsRef.current?.close()
    }
  }, [station.id, station.name, station.showDeveloperTools])

  const play = (name: string) => {
    fetch(`/api/play/${encodeURIComponent(name)}?station_id=${encodeURIComponent(station.id)}`, { method: 'POST' }).catch(() => undefined)
  }
  const latest = station.previewAll ? previewItems[previewIndex] : announcements[0]
  const history = station.previewAll ? previewItems.filter((_, index) => index !== previewIndex) : announcements.slice(1)

  return (
    <div className="app-shell">
      <header className="topbar">
        <h1>{station.name}</h1>
      </header>

      <main className="station-main">
        {station.previewAll && (
          <nav className="preview-switcher" aria-label="동적 자막 테스트 장면">
            {previewItems.map((announcement, index) => (
              <button
                key={announcement.id}
                type="button"
                data-severity={announcement.severity}
                aria-pressed={previewIndex === index}
                onClick={() => setPreviewIndex(index)}
              >
                {announcement.category}
              </button>
            ))}
          </nav>
        )}

        {(interim || playing) && (
          <section className={`live-caption ${interim ? 'has-caption' : ''}`} aria-live="polite" aria-atomic="true">
            <div className="live-label"><span aria-hidden="true" />{interim ? '임시 자막 · 확정 전' : '음성 인식 중'}</div>
            <p>{interim || `${playing} 방송을 처리하고 있습니다.`}</p>
          </section>
        )}

        {latest ? <FocusAnnouncement key={latest.id ?? latest.session_id ?? latest.ts} announcement={latest} showTechnical={station.showDeveloperTools} /> : <WaitingPanel stationName={station.name} />}

        {history.length > 0 && (
          <section className="history" aria-labelledby="history-title">
            <div className="section-title">
              <h2 id="history-title">{station.name} 최근 안내</h2>
              <span>{history.length}건</span>
            </div>
            <div className="history-list">
              {history.map((announcement) => (
                <article key={`${announcement.ts}-${announcement.id ?? announcement.session_id ?? announcement.original}`} className="history-card" data-severity={announcement.severity}>
                  <div className="history-head">
                    <SituationBadge announcement={announcement} />
                    <time dateTime={new Date(announcement.ts).toISOString()}>{formatTime(announcement.ts)}</time>
                  </div>
                  <p>{announcement.simplified}</p>
                </article>
              ))}
            </div>
          </section>
        )}

      </main>

      {station.showDeveloperTools && (
        <footer className="test-dock">
          <details>
            <summary><span>개발용 테스트 음성</span><small>{samples.length}개</small></summary>
            <div className="test-content">
              <p>긴급도는 음량이 아니라 방송 내용의 분류 결과로 결정됩니다.</p>
              <div className="sample-list">
                {samples.map((sample) => (
                  <button key={sample} onClick={() => play(sample)} disabled={playing !== null}><span aria-hidden="true">▶</span> {sample}</button>
                ))}
              </div>
            </div>
          </details>
        </footer>
      )}
    </div>
  )
}

export default function App() {
  const station = resolveStationPage()
  return station ? <StationPage station={station} /> : <InvalidStationPage />
}
