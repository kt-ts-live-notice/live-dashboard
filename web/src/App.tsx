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
}

interface ServerEvent {
  type: 'stt-interim' | 'stt-final' | 'announcement' | 'filtered' | 'status' | 'session-error'
  [key: string]: unknown
}

const SEVERITY_INFO: Record<Severity, { symbol: string; cue: string }> = {
  일반: { symbol: 'i', cue: '안내 정보' },
  주의: { symbol: '▲', cue: '변경·지연 확인' },
  긴급: { symbol: '!', cue: '즉시 행동' },
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
      original: '긴급 상황입니다. 역사 내 화재가 발생하였습니다. 가까운 비상구로 대피해 주십시오.',
      simplified: '역사 안에 화재가 발생했습니다. 직원 안내에 따라 가까운 비상구로 지금 대피하세요.',
      category: '긴급', severity: '긴급', latencyMs: 2410, ts: now, device_id: stationId,
    },
    {
      id: -2,
      original: '부산 방면 열차의 타는 곳이 3번에서 5번 승강장으로 변경되었습니다.',
      simplified: '부산 방면 열차는 5번 승강장에서 탑승하세요.',
      category: '승강장 변경', severity: '주의', latencyMs: 1880, ts: now - 3 * 60_000, device_id: stationId,
    },
    {
      id: -3,
      original: '대합실 물품 보관함 운영 시간을 안내드립니다.',
      simplified: '물품 보관함은 밤 11시까지 이용할 수 있습니다.',
      category: '시설 안내', severity: '일반', latencyMs: 1640, ts: now - 8 * 60_000, device_id: stationId,
    },
  ]
}

function SeverityBadge({ severity }: { severity: Severity }) {
  const info = SEVERITY_INFO[severity]
  return (
    <div className="severity-badge" aria-label={`${severity}, ${info.cue}`}>
      <span className="severity-symbol" aria-hidden="true">{info.symbol}</span>
      <span className="severity-copy">
        <strong>{severity}</strong>
        <small>{info.cue}</small>
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
        <SeverityBadge severity={announcement.severity} />
        <div className="focus-meta">
          {announcement.category !== announcement.severity && <span className="category-chip">{announcement.category}</span>}
          <time dateTime={new Date(announcement.ts).toISOString()}>{formatTime(announcement.ts)}</time>
        </div>
      </div>

      <p className={`focus-message ${textLengthClass(announcement.simplified)}`}>{announcement.simplified}</p>

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
  const [announcements, setAnnouncements] = useState<Announcement[]>(() => previewAnnouncements(station.id, station.previewAll))
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
  const latest = announcements[0]
  const history = announcements.slice(1)

  return (
    <div className="app-shell">
      <header className="topbar">
        <h1>{station.name}</h1>
      </header>

      <main className="station-main">
        {(interim || playing) && (
          <section className={`live-caption ${interim ? 'has-caption' : ''}`} aria-live="polite" aria-atomic="true">
            <div className="live-label"><span aria-hidden="true" />{interim ? '임시 자막 · 확정 전' : '음성 인식 중'}</div>
            <p>{interim || `${playing} 방송을 처리하고 있습니다.`}</p>
          </section>
        )}

        {latest ? <FocusAnnouncement announcement={latest} showTechnical={station.showDeveloperTools} /> : <WaitingPanel stationName={station.name} />}

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
                    <SeverityBadge severity={announcement.severity} />
                    <time dateTime={new Date(announcement.ts).toISOString()}>{formatTime(announcement.ts)}</time>
                  </div>
                  <p>{announcement.simplified}</p>
                  <span className="history-category">{announcement.category}</span>
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
