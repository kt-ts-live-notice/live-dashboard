import { useEffect, useRef, useState } from 'react'
import type { AnnouncementCategory, AnnouncementSeverity } from '@live-notice/contracts'
import { resolveStationPage, type StationPageContext } from './stationRoute'

interface Announcement {
  id?: number
  original: string
  simplified: string
  category: AnnouncementCategory
  label?: string
  severity: AnnouncementSeverity
  latencyMs: number
  ts: number
  device_id?: string
  session_id?: string
  display?: {
    lead: string
    conclusion: string
    support: string
  }
}

interface ServerEvent {
  type: 'stt-interim' | 'stt-final' | 'announcement' | 'filtered' | 'status' | 'session-error'
  [key: string]: unknown
}

interface DemoSample {
  name: string
  title: string
  source: '실제 역사 녹음' | '시나리오 녹음'
}

const DEMO_SAMPLES: DemoSample[] = [
  { name: 'kt_93', title: '열차 진입', source: '실제 역사 녹음' },
  { name: 'kt_89', title: '발빠짐 주의', source: '실제 역사 녹음' },
  { name: 'kt_100', title: '출입문 닫힘', source: '실제 역사 녹음' },
  { name: 'skip-stop', title: '열차 통과', source: '시나리오 녹음' },
]

const SEVERITY_INFO: Record<AnnouncementSeverity, { symbol: string }> = {
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

function dynamicConclusionClass(text: string): 'dynamic-short' | 'dynamic-medium' | 'dynamic-long' {
  const length = [...text.replace(/\s/g, '')].length
  if (length <= 9) return 'dynamic-short'
  if (length <= 15) return 'dynamic-medium'
  return 'dynamic-long'
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
}

function SituationBadge({ announcement }: { announcement: Announcement }) {
  const info = SEVERITY_INFO[announcement.severity]
  const label = announcement.label ?? announcement.category
  return (
    <div className="severity-badge" aria-label={`${label}, 분류 ${announcement.category}, 중요도 ${announcement.severity}`}>
      <span className="severity-symbol" aria-hidden="true">{info.symbol}</span>
      <span className="severity-copy">
        <strong>{label}</strong>
      </span>
    </div>
  )
}

function FocusAnnouncement({ announcement }: { announcement: Announcement }) {
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
          <p className="dynamic-lead">{announcement.display.lead}</p>
          <p className={`dynamic-conclusion ${dynamicConclusionClass(announcement.display.conclusion)}`}>{announcement.display.conclusion}</p>
          <p className="dynamic-support">{announcement.display.support}</p>
        </div>
      ) : (
        <p className={`focus-message ${textLengthClass(announcement.simplified)}`}>{announcement.simplified}</p>
      )}
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

function WaitingPanel({ stationName, demo }: { stationName: string; demo: boolean }) {
  return (
    <section className="waiting-panel" aria-live="polite">
      <span className="waiting-mark" aria-hidden="true">···</span>
      <h2>{demo ? <>음성을 선택하면<br />자막이 표시됩니다</> : <>{stationName} 방송을<br />기다리고 있습니다</>}</h2>
    </section>
  )
}

function demoSampleTitle(name: string): string {
  return DEMO_SAMPLES.find((sample) => sample.name === name)?.title ?? name
}

function appendTranscript(previous: string, next: string): string {
  const segment = next.trim()
  if (!segment || previous.endsWith(segment)) return previous
  return `${previous} ${segment}`.trim()
}

function StreamingCaption({ committed, interim }: { committed: string; interim: string }) {
  const current = interim.trim()
  const currentIncludesCommitted = committed && current.startsWith(committed)
  return (
    <section className="streaming-caption" aria-live="polite" aria-atomic="false">
      <div className="streaming-head">
        <span className="streaming-dot" aria-hidden="true" />
        <strong>실시간 자막</strong>
        <span>인식 중</span>
      </div>
      <p className={committed || current ? 'streaming-text' : 'streaming-text is-waiting'}>
        {currentIncludesCommitted ? (
          <span key={current} className="streaming-current">{current}</span>
        ) : (
          <>
            {committed && <span className="streaming-committed">{committed}</span>}
            {committed && current && ' '}
            {current && <span key={current} className="streaming-current">{current}</span>}
          </>
        )}
        {!committed && !current && '음성을 듣고 있습니다'}
        <span className="streaming-caret" aria-hidden="true" />
      </p>
    </section>
  )
}

function StationPage({ station }: { station: StationPageContext }) {
  const [announcements, setAnnouncements] = useState<Announcement[]>([])
  const [interim, setInterim] = useState('')
  const [committedTranscript, setCommittedTranscript] = useState('')
  const [isRecognizing, setIsRecognizing] = useState(false)
  const [playing, setPlaying] = useState<string | null>(null)
  const [samples, setSamples] = useState<string[]>([])
  const [selectedSample, setSelectedSample] = useState<string | null>(null)
  const [localPlaying, setLocalPlaying] = useState(false)
  const [demoNotice, setDemoNotice] = useState('')
  const wsRef = useRef<WebSocket | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const liveSessionRef = useRef<string | null>(null)
  const isDemo = station.mode === 'demo'

  useEffect(() => {
    document.title = isDemo ? `${station.name} 음성 데모` : `${station.name} 안내방송`
    if (isDemo) {
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
        if (serverEvent.type === 'stt-interim' || serverEvent.type === 'stt-final') {
          const sessionKey = typeof serverEvent.session_id === 'string' ? `session:${serverEvent.session_id}` : liveSessionRef.current
          if (sessionKey && liveSessionRef.current !== sessionKey) {
            liveSessionRef.current = sessionKey
            setCommittedTranscript('')
            setInterim('')
          }
          setIsRecognizing(true)
        }
        if (serverEvent.type === 'stt-interim') setInterim(String(serverEvent.text ?? ''))
        if (serverEvent.type === 'stt-final') {
          setCommittedTranscript((previous) => appendTranscript(previous, String(serverEvent.text ?? '')))
          setInterim('')
        }
        if (serverEvent.type === 'status') {
          const nextPlaying = typeof serverEvent.playing === 'string' ? serverEvent.playing : null
          setPlaying(nextPlaying)
          if (nextPlaying) {
            const sessionKey = `sample:${nextPlaying}`
            if (liveSessionRef.current !== sessionKey) {
              liveSessionRef.current = sessionKey
              setCommittedTranscript('')
              setInterim('')
            }
            setIsRecognizing(true)
          }
          if (serverEvent.playing === null) setLocalPlaying(false)
          if (typeof serverEvent.error === 'string') {
            setIsRecognizing(false)
            setCommittedTranscript('')
            setInterim('')
            setDemoNotice(`분석 오류: ${serverEvent.error}`)
          }
        }
        if (serverEvent.type === 'announcement') {
          setDemoNotice('')
          setIsRecognizing(false)
          setCommittedTranscript('')
          setInterim('')
          setAnnouncements((previous) => [serverEvent as unknown as Announcement, ...previous].slice(0, 20))
        }
        if (serverEvent.type === 'filtered') {
          setIsRecognizing(false)
          setCommittedTranscript('')
          setInterim('')
          setDemoNotice('이 음성은 안내방송으로 분류되지 않았습니다.')
        }
        if (serverEvent.type === 'session-error') {
          setIsRecognizing(false)
          setCommittedTranscript('')
          setInterim('')
          setDemoNotice('음성 처리 중 오류가 발생했습니다.')
        }
      }
    }
    connect()
    return () => {
      closed = true
      const activeSocket = wsRef.current
      if (activeSocket?.readyState === WebSocket.CONNECTING) activeSocket.onopen = () => activeSocket.close()
      else activeSocket?.close()
    }
  }, [isDemo, station.id, station.name])

  const play = async (name: string) => {
    const audio = audioRef.current
    if (!audio || playing || localPlaying) return
    setSelectedSample(name)
    setDemoNotice('')
    setLocalPlaying(true)
    liveSessionRef.current = `sample:${name}`
    setCommittedTranscript('')
    setInterim('')
    setIsRecognizing(true)
    audio.src = `/api/samples/${encodeURIComponent(name)}/audio`
    audio.load()
    const browserPlayback = audio.play()
    try {
      const [response] = await Promise.all([
        fetch(`/api/play/${encodeURIComponent(name)}?station_id=${encodeURIComponent(station.id)}`, { method: 'POST' }),
        browserPlayback,
      ])
      if (!response.ok) {
        const problem = await response.json().catch(() => null) as { error?: string } | null
        throw new Error(problem?.error ?? '데모를 시작할 수 없습니다.')
      }
    } catch (error) {
      audio.pause()
      audio.currentTime = 0
      setLocalPlaying(false)
      setIsRecognizing(false)
      setDemoNotice(error instanceof Error ? error.message : '데모를 시작할 수 없습니다.')
    }
  }
  const latest = announcements[0]
  const history = isRecognizing ? announcements : announcements.slice(1)
  const featuredSamples = DEMO_SAMPLES.filter((sample) => samples.includes(sample.name))
  const busy = playing !== null || localPlaying

  return (
    <div className="app-shell">
      <header className="topbar">
        <h1>{station.name}</h1>
        {isDemo && <span className="demo-badge">DEMO</span>}
      </header>

      <main className="station-main">
        {isDemo && (
          <section className="demo-player" aria-labelledby="demo-player-title">
            <div className="demo-player-head">
              <div>
                <h2 id="demo-player-title">녹음 재생</h2>
                <p>소리와 자막 분석이 함께 시작됩니다.</p>
              </div>
              {busy && <span className="demo-running">분석 중</span>}
            </div>
            <div className="demo-sample-grid">
              {featuredSamples.map((sample) => (
                <button
                  key={sample.name}
                  type="button"
                  aria-pressed={selectedSample === sample.name}
                  onClick={() => void play(sample.name)}
                  disabled={busy}
                >
                  <span className="demo-play-icon" aria-hidden="true">▶</span>
                  <span><strong>{sample.title}</strong><small>{sample.source}</small></span>
                </button>
              ))}
            </div>
            <audio
              ref={audioRef}
              className={selectedSample ? 'demo-audio is-visible' : 'demo-audio'}
              controls
              preload="metadata"
              aria-label={selectedSample ? `${demoSampleTitle(selectedSample)} 녹음` : '데모 녹음 재생기'}
              onEnded={() => setLocalPlaying(false)}
              onError={() => setDemoNotice('음성 파일을 재생할 수 없습니다.')}
            />
            {demoNotice && <p className="demo-notice" role="status">{demoNotice}</p>}
            {samples.length > featuredSamples.length && (
              <details className="all-samples">
                <summary>전체 녹음 {samples.length}개</summary>
                <div className="sample-list">
                  {samples.map((sample) => (
                    <button key={sample} type="button" onClick={() => void play(sample)} disabled={busy}>▶ {sample}</button>
                  ))}
                </div>
              </details>
            )}
          </section>
        )}

        {isRecognizing
          ? <StreamingCaption committed={committedTranscript} interim={interim} />
          : latest
            ? <FocusAnnouncement key={latest.id ?? latest.session_id ?? latest.ts} announcement={latest} />
            : <WaitingPanel stationName={station.name} demo={isDemo} />}

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
    </div>
  )
}

export default function App() {
  const station = resolveStationPage()
  return station ? <StationPage station={station} /> : <InvalidStationPage />
}
