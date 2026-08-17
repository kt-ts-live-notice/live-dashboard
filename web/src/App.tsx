import {
  useEffect,
  useRef,
  useState,
} from 'react'

import type {
  AnnouncementCategory,
  AnnouncementSeverity,
} from '@live-notice/contracts'

import {
  resolveStationPage,
  type StationPageContext,
} from './stationRoute'

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
  type:
    | 'stt-interim'
    | 'stt-final'
    | 'announcement'
    | 'filtered'
    | 'status'
    | 'session-error'

  [key: string]: unknown
}

interface DemoSample {
  name: string
  title: string
  source:
    | '실제 역사 녹음'
    | '시나리오 녹음'
  audio: string
}

type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'

type LiveState =
  | 'waiting'
  | 'streaming'
  | 'announcement'


/* =========================================================
   DEMO SAMPLE
   ========================================================= */

const DEMO_SAMPLES: DemoSample[] = [
  {
    name: 'train_arrival',
    title: '열차 진입',
    source: '실제 역사 녹음',
    audio: `${import.meta.env.BASE_URL}audio/train_arrival.wav`,
  },
  {
    name: 'gap_warning',
    title: '발빠짐 주의',
    source: '실제 역사 녹음',
    audio: `${import.meta.env.BASE_URL}audio/gap_warning.wav`,
  },
  {
    name: 'door_closing',
    title: '출입문 닫힘',
    source: '실제 역사 녹음',
    audio: `${import.meta.env.BASE_URL}audio/door_closing.wav`,
  },
  {
    name: 'train_passing',
    title: '열차 통과',
    source: '시나리오 녹음',
    audio: `${import.meta.env.BASE_URL}audio/train_passing.wav`,
  },
  {
    name: 'train_breakdown',
    title: '열차 일시 정차',
    source: '시나리오 녹음',
    audio: `${import.meta.env.BASE_URL}audio/train_breakdown.wav`,
  },
  {
    name: 'restricted_items',
    title: '반입 제한',
    source: '시나리오 녹음',
    audio: `${import.meta.env.BASE_URL}audio/restricted_items.wav`,
  },
  {
    name: 'fire_evacuation',
    title: '화재 대피',
    source: '시나리오 녹음',
    audio: `${import.meta.env.BASE_URL}audio/fire_evacuation.wav`,
  },
]


/* =========================================================
   안내 등급
   ========================================================= */

const SEVERITY_INFO: Record<
  AnnouncementSeverity,
  {
    symbol: string
    title: string
  }
> = {
  일반: {
    symbol: 'i',
    title: '일반 안내',
  },

  주의: {
    symbol: '▲',
    title: '주의',
  },

  긴급: {
    symbol: '!',
    title: '긴급',
  },
}


/* =========================================================
   DEMO ANNOUNCEMENT

   데모에서는 AI가 결과를 만드는 것이 아니라
   선택한 실제 녹음 샘플에 대응하는 승객 화면을
   미리 정의하여 안정적으로 시연한다.
   ========================================================= */

function createDemoAnnouncement(
  name: string,
  stationId: string,
): Announcement | null {
  const now = Date.now()

  const common = {
    id: -now,
    latencyMs: 0,
    ts: now,
    device_id: stationId,
  }

  switch (name) {
    case 'train_arrival':
      return {
        ...common,
        original:
          '지금 천안, 천안 간 열차가 들어오고 있습니다.',
        simplified:
          '열차가 들어오고 있습니다.',
        category:
          '일반 안내' as AnnouncementCategory,
        label: '열차 진입',
        severity: '주의',
        display: {
          lead:
            '열차가',
          conclusion:
            '들어오고 있습니다',
          support:
            '안전선 안쪽에서\n기다려 주세요',
        },
      }

    case 'gap_warning':
      return {
        ...common,
        original:
          '열차와 승강장 사이가 넓으니 발이 빠지지 않도록 주의하시기 바랍니다.',
        simplified:
          '열차와 승강장 사이가 넓습니다. 승하차할 때 발밑을 확인해 주세요.',
        category:
          '일반 안내' as AnnouncementCategory,
        label: '발빠짐 주의',
        severity: '주의',
        display: {
          lead:
            '열차와 승강장 사이가',
          conclusion:
            '넓습니다',
          support:
            '승하차할 때\n발밑을 확인해 주세요',
        },
      }

    case 'door_closing':
      return {
        ...common,
        original:
          '출입문이 닫힙니다. 무리하게 승하차하지 마시기 바랍니다.',
        simplified:
          '출입문이 닫힙니다. 무리하게 승하차하지 말고 출입문에서 물러나 주세요.',
        category:
          '일반 안내' as AnnouncementCategory,
        label: '출입문 닫힘',
        severity: '주의',
        display: {
          lead:
            '곧',
          conclusion:
            '출입문이\n닫힙니다',
          support:
            '무리하게 승하차하지 말고\n출입문에서 물러나 주세요',
        },
      }

    case 'train_passing':
      return {
        ...common,
        original:
          '지금 들어오는 열차는 우리 역을 통과하는 열차입니다. 안전선 안쪽으로 이동하여 주시기 바랍니다.',
        simplified:
          '지금 들어오는 열차는 우리 역을 통과합니다. 안전선 안쪽으로 이동해 주세요.',
        category:
          '열차 통과' as AnnouncementCategory,
        label: '열차 통과',
        severity: '주의',
        display: {
          lead:
            '지금 들어오는 열차는',
          conclusion:
            '우리 역을\n통과합니다',
          support:
            '안전선 안쪽으로\n이동해 주세요',
        },
      }

    case 'train_breakdown':
      return {
        ...common,
        original:
          '열차 고장으로 인해 잠시 정차합니다. 잠시만 기다려 주십시오.',
        simplified:
          '열차 고장으로 인해 잠시 정차합니다. 잠시만 기다려 주세요.',
        category:
          '일반 안내' as AnnouncementCategory,
        label: '열차 일시 정차',
        severity: '일반',
        display: {
          lead:
            '열차 고장으로 인해',
          conclusion:
            '잠시 정차 중입니다',
          support:
            '잠시만 기다려 주세요',
        },
      }

    case 'restricted_items':
      return {
        ...common,
        original:
          '안내 말씀드립니다. 2026년 7월 1일부터 화재 사고 예방을 위해 전동 킥보드, 전기자전거, 전동휠 등 리튬 배터리로 구동되는 모든 이동수단 및 대용량 리튬 배터리의 역과 열차 내 휴대 반입을 제한합니다. 안전한 철도 환경 조성을 위해 승객 여러분의 협조를 부탁드립니다.',
        simplified:
          '전동 킥보드·전기자전거·전동휠 등 리튬 배터리 이동수단과 대용량 리튬 배터리는 역·열차 내 반입이 제한됩니다.',
        category:
          '일반 안내' as AnnouncementCategory,
        label: '리튬 배터리 반입 제한',
        severity: '일반',
        display: {
          lead:
            '전동 킥보드·전기자전거·전동휠 등',
          conclusion:
            '역·열차 내\n반입이 제한됩니다',
          support:
            '해당 물품은 역과 열차 안으로\n가져오지 말아 주세요',
        },
      }

    case 'fire_evacuation':
      return {
        ...common,
        original:
          '승객 여러분, 지금 열차에 화재, 화재가 발생하였습니다. 손수건이나 옷으로 입과 코를 막고 신속하게 옆 칸이나 안전한 곳으로 대피해 주십시오. 또한 통로문 옆에는 소화기가 비치되어 있으니 초기 진화에 활용하시기 바랍니다. 정차 후 출입문이 열리지 않으면 출입문 옆 의자 밑에 있는 비상 손잡이를 앞으로 당겨 주십시오. 공기가 빠지면 손으로 출입문을 연 후 승강장 안전문 수동 개방 손잡이를 화살표 방향으로 돌리거나 비상 레버를 앞으로 밀어 신속히 대피하시기 바랍니다.',
        simplified:
          '열차에 화재가 발생했습니다. 입과 코를 막고 옆 칸이나 안전한 곳으로 신속히 대피하세요. 출입문이 열리지 않으면 비상 손잡이를 당겨 문을 수동으로 열고 승강장 안전문을 수동 개방하세요.',
        category:
          '긴급 안내' as AnnouncementCategory,
        label: '열차 화재',
        severity: '긴급',
        display: {
          lead:
            '열차에\n화재가 발생했습니다',
          conclusion:
            '입과 코를 막고\n신속히 대피하세요',
          support:
            '옆 칸 또는 안전한 곳으로\n이동해 주세요',
        },
      }

    default:
      return null
  }
}


/* =========================================================
   TEXT SIZE HELPERS
   ========================================================= */

function textLengthClass(
  text: string,
):
  | 'copy-short'
  | 'copy-medium'
  | 'copy-long' {
  const length = [...text].length

  if (length <= 34) {
    return 'copy-short'
  }

  if (length <= 66) {
    return 'copy-medium'
  }

  return 'copy-long'
}


function dynamicConclusionClass(
  text: string,
):
  | 'dynamic-short'
  | 'dynamic-medium'
  | 'dynamic-long' {
  const length = [
    ...text.replace(/\s/g, ''),
  ].length

  if (length <= 9) {
    return 'dynamic-short'
  }

  if (length <= 15) {
    return 'dynamic-medium'
  }

  return 'dynamic-long'
}


function supportingTextClass(
  text: string,
):
  | 'support-short'
  | 'support-medium'
  | 'support-long' {
  const length = [...text].length

  if (length <= 24) {
    return 'support-short'
  }

  if (length <= 46) {
    return 'support-medium'
  }

  return 'support-long'
}


/* =========================================================
   TIME
   ========================================================= */

function formatTime(
  ts: number,
): string {
  return new Date(
    ts,
  ).toLocaleTimeString(
    'ko-KR',
    {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    },
  )
}


function CurrentClock() {
  const [now, setNow] =
    useState(
      () => Date.now(),
    )

  useEffect(() => {
    let timer = 0

    const update = () => {
      const current =
        Date.now()

      setNow(current)

      timer =
        window.setTimeout(
          update,
          60_000 -
            (current % 60_000) +
            50,
        )
    }

    update()

    return () =>
      window.clearTimeout(
        timer,
      )
  }, [])

  return (
    <time
      className="current-clock"
      dateTime={new Date(
        now,
      ).toISOString()}
      aria-label={`현재 시각 ${formatTime(
        now,
      )}`}
    >
      {formatTime(now)}
    </time>
  )
}


/* =========================================================
   CONNECTION
   ========================================================= */

function ConnectionStatus({
  state,
}: {
  state: ConnectionState
}) {
  const label =
    state === 'connected'
      ? '실시간 안내 수신 중'
      : state === 'reconnecting'
        ? '안내 연결 재시도 중'
        : '안내 연결 중'

  return (
    <div
      className="connection-status"
      data-state={state}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span
        className="connection-dot"
        aria-hidden="true"
      />

      <span>
        {label}
      </span>
    </div>
  )
}


/* =========================================================
   HEADER
   ========================================================= */

function StationHeader({
  stationName,
  connectionState,
  demo,
  demoPlaying = false,
  demoRemaining,
  onOpenDemo,
}: {
  stationName: string
  connectionState: ConnectionState
  demo: boolean
  demoPlaying?: boolean
  demoRemaining?: string | null
  onOpenDemo?: () => void
}) {
  return (
    <header className="topbar">
      <div className="station-identity">
        <h1>
          {stationName}
        </h1>

        {demo ? (
          <div
            className="connection-status"
            data-state="connected"
            role="status"
          >
            <span
              className="connection-dot"
              aria-hidden="true"
            />
            <span>
              데모 모드
            </span>
          </div>
        ) : (
          <ConnectionStatus
            state={
              connectionState
            }
          />
        )}
      </div>

      <div className="topbar-tools">
        {demo && (
          <div className="demo-header-control">
            {demoPlaying && (
              <span
                className="demo-countdown"
                aria-label={`데모 음성 남은 시간 ${demoRemaining ?? '--:--'}`}
              >
                <span className="demo-countdown-label">
                  남은
                </span>
                <strong>
                  {demoRemaining ?? '--:--'}
                </strong>
              </span>
            )}

            <button
              type="button"
              className="demo-trigger-button"
              onClick={onOpenDemo}
              aria-haspopup="dialog"
              aria-label="시연 음성 선택 열기"
            >
              시연
            </button>
          </div>
        )}

        <CurrentClock />
      </div>
    </header>
  )
}


/* =========================================================
   SEVERITY BADGE
   ========================================================= */

function SituationBadge({
  announcement,
}: {
  announcement: Announcement
}) {
  const info =
    SEVERITY_INFO[
      announcement.severity
    ]

  const label =
    announcement.label ??
    announcement.category

  return (
    <div
      className="severity-badge"
      aria-label={`${info.title}, ${label}, 분류 ${announcement.category}, 중요도 ${announcement.severity}`}
    >
      <span
        className="severity-symbol"
        aria-hidden="true"
      >
        {info.symbol}
      </span>

      <span className="severity-copy">
        <span className="severity-level">
          {info.title}
        </span>

        <strong>
          {label}
        </strong>
      </span>
    </div>
  )
}


/* =========================================================
   CURRENT ANNOUNCEMENT
   ========================================================= */

function FocusAnnouncement({
  announcement,
}: {
  announcement: Announcement
}) {
  const isAttention =
    announcement.severity ===
    '주의'

  const isEmergency =
    announcement.severity ===
    '긴급'

  const isTrainArrival =
    announcement.label ===
    '열차 진입'

  const isGapWarning =
    announcement.label ===
    '발빠짐 주의'

  const isDoorClosing =
    announcement.label ===
    '출입문 닫힘'

  const isTrainPassing =
    announcement.label ===
    '열차 통과'

  const isTrainBreakdown =
    announcement.label ===
    '열차 일시 정차'

  const isRestrictedItems =
    announcement.label ===
    '리튬 배터리 반입 제한'

  const isFireEvacuation =
    announcement.label ===
    '열차 화재'

  /*
    ========================================================
    열차 화재 — 긴급 전용 화면

    즉시 행동 → 이동 방향 → 현재 상황 → 조건부 대피 절차
    ========================================================
  */
  if (
    isEmergency &&
    isFireEvacuation &&
    announcement.display
  ) {
    return (
      <article
        className="focus-announcement fire-emergency"
        data-severity="긴급"
        data-label="열차 화재"
      >
        <section
          className="fire-emergency-hero"
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
        >
          <header className="fire-emergency-head">
            <div className="fire-emergency-title">
              <span
                className="fire-emergency-symbol"
                aria-hidden="true"
              >
                !
              </span>

              <div>
                <span>
                  긴급
                </span>

                <strong>
                  열차 화재
                </strong>
              </div>
            </div>

            <time
              dateTime={new Date(
                announcement.ts,
              ).toISOString()}
              aria-label={`방송 시각 ${formatTime(
                announcement.ts,
              )}`}
            >
              {formatTime(
                announcement.ts,
              )}
            </time>
          </header>

          <div className="fire-emergency-primary">
            <span className="message-kicker">
              즉시 행동
            </span>

            <p
              className={`dynamic-conclusion ${dynamicConclusionClass(
                announcement.display
                  .conclusion,
              )}`}
            >
              {
                announcement.display
                  .conclusion
              }
            </p>

            <div className="fire-emergency-move">
              <span
                className="fire-emergency-move-arrow"
                aria-hidden="true"
              >
                →
              </span>

              <p>
                {
                  announcement.display
                    .support
                }
              </p>
            </div>
          </div>
        </section>

        <section className="fire-emergency-context">
          <span className="message-kicker">
            현재 상황
          </span>

          <p className="dynamic-lead">
            {
              announcement.display
                .lead
            }
          </p>
        </section>

        <section className="fire-emergency-procedure">
          <div className="fire-procedure-heading">
            <span className="message-kicker">
              출입문이 열리지 않으면
            </span>

            <strong>
              비상 개방 후 대피
            </strong>
          </div>

          <ol className="fire-procedure-list">
            <li>
              <span className="fire-procedure-number">
                01
              </span>

              <p>
                출입문 옆 의자 밑
                <strong>
                  비상 손잡이를 앞으로 당기세요
                </strong>
              </p>
            </li>

            <li>
              <span className="fire-procedure-number">
                02
              </span>

              <p>
                공기가 빠지면
                <strong>
                  출입문을 손으로 여세요
                </strong>
              </p>
            </li>

            <li>
              <span className="fire-procedure-number">
                03
              </span>

              <p>
                승강장 안전문을
                <strong>
                  수동 개방하고 대피하세요
                </strong>
              </p>
            </li>
          </ol>
        </section>

        <section className="fire-extinguisher-note">
          <span>
            추가 안내
          </span>

          <p>
            <strong>
              소화기
            </strong>
            는 통로문 옆에 비치되어 있습니다.
          </p>
        </section>
      </article>
    )
  }

  /*
    ========================================================
    긴급

    행동 → 사건 정보 → 현재 상황 → 다음 행동

    사용자가 처음 보는 순간
    "무엇을 해야 하는지"부터 보이게 한다.
    ========================================================
  */
  if (
    isEmergency &&
    announcement.display
  ) {
    return (
      <article
        className="focus-announcement"
        data-severity="긴급"
        data-label={
          announcement.label ??
          announcement.category
        }
      >
        <section
          className="emergency-action"
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
        >
          <div className="emergency-level">
            <span
              className="emergency-level-symbol"
              aria-hidden="true"
            >
              !
            </span>

            <span>
              긴급
            </span>
          </div>

          <span className="message-kicker">
            지금 바로
          </span>

          <p
            className={`dynamic-conclusion ${dynamicConclusionClass(
              announcement.display
                .conclusion,
            )}`}
          >
            {
              announcement.display
                .conclusion
            }
          </p>
        </section>

        <div className="emergency-meta">
          <strong>
            {announcement.label ??
              announcement.category}
          </strong>

          <time
            dateTime={new Date(
              announcement.ts,
            ).toISOString()}
            aria-label={`방송 시각 ${formatTime(
              announcement.ts,
            )}`}
          >
            {formatTime(
              announcement.ts,
            )}
          </time>
        </div>

        <section className="emergency-context">
          <span className="message-kicker">
            현재 상황
          </span>

          <p className="dynamic-lead">
            {
              announcement.display
                .lead
            }
          </p>
        </section>

        <section className="emergency-next-action">
          <span className="message-kicker">
            다음 행동
          </span>

          <p
            className={`dynamic-support ${supportingTextClass(
              announcement.display
                .support,
            )}`}
          >
            {
              announcement.display
                .support
            }
          </p>
        </section>
      </article>
    )
  }

  /*
    긴급 fallback
  */
  if (isEmergency) {
    return (
      <article
        className="focus-announcement"
        data-severity="긴급"
        data-label={
          announcement.label ??
          announcement.category
        }
      >
        <p
          className={`focus-message emergency-fallback ${textLengthClass(
            announcement.simplified,
          )}`}
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
        >
          {
            announcement.simplified
          }
        </p>
      </article>
    )
  }

  /*
    ========================================================
    일반 / 주의
    ========================================================
  */
  return (
    <article
      className="focus-announcement"
      data-severity={
        announcement.severity
      }
      data-label={
        announcement.label ??
        announcement.category
      }
      aria-live="polite"
      aria-atomic="true"
    >
      <header className="focus-head">
        <SituationBadge
          announcement={
            announcement
          }
        />

        <time
          className="focus-time"
          dateTime={new Date(
            announcement.ts,
          ).toISOString()}
          aria-label={`방송 시각 ${formatTime(
            announcement.ts,
          )}`}
        >
          {formatTime(
            announcement.ts,
          )}
        </time>
      </header>

      {announcement.display ? (
        isAttention ? (
          /*
            ================================================
            주의

            위험 상황
            ↓
            안전 행동
            ================================================
          */
          <div className="dynamic-caption dynamic-caption-attention">
            <section className="announcement-context">
              <span className="message-kicker context-kicker">
                현재 상황
              </span>

              <p className="dynamic-lead">
                {
                  announcement.display
                    .lead
                }
              </p>

              <p
                className={`dynamic-conclusion ${dynamicConclusionClass(
                  announcement.display
                    .conclusion,
                )}`}
              >
                {
                  announcement.display
                    .conclusion
                }
              </p>

              {isTrainArrival && (
                <div
                  className="train-arrival-approach"
                  aria-label="열차 진입 상태"
                >
                  <span className="train-arrival-approach-label">
                    열차 접근
                  </span>

                  <div
                    className="train-arrival-rail"
                    aria-hidden="true"
                  >
                    <span className="train-arrival-rail-dot is-start" />
                    <span className="train-arrival-rail-line" />
                    <span className="train-arrival-rail-arrow">
                      →
                    </span>
                  </div>

                  <strong>
                    진입 중
                  </strong>
                </div>
              )}

              {isGapWarning && (
                <div
                  className="gap-warning-visual"
                  role="img"
                  aria-label="승강장과 열차 사이 간격이 넓습니다"
                >
                  <div
                    className="gap-warning-track"
                    aria-hidden="true"
                  >
                    <div className="gap-warning-side gap-warning-side-platform">
                      <span className="gap-warning-side-label">
                        승강장
                      </span>

                      <div className="gap-warning-edge">
                        <span className="gap-warning-surface" />
                        <span className="gap-warning-boundary" />
                      </div>
                    </div>

                    <div className="gap-warning-gap">
                      <span className="gap-warning-gap-arrow">
                        ↔
                      </span>

                      <strong>
                        간격 넓음
                      </strong>
                    </div>

                    <div className="gap-warning-side gap-warning-side-train">
                      <span className="gap-warning-side-label">
                        열차
                      </span>

                      <div className="gap-warning-edge">
                        <span className="gap-warning-boundary" />
                        <span className="gap-warning-surface" />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {isDoorClosing && (
                <div
                  className="door-closing-visual"
                  role="img"
                  aria-label="출입문이 가운데 방향으로 닫히고 있습니다"
                >
                  <div
                    className="door-closing-track"
                    aria-hidden="true"
                  >
                    <span className="door-panel door-panel-left" />

                    <span className="door-arrow">
                      →
                    </span>

                    <span className="door-center-line" />

                    <span className="door-arrow">
                      ←
                    </span>

                    <span className="door-panel door-panel-right" />
                  </div>

                  <strong className="door-closing-progress">
                    닫히는 중
                  </strong>
                </div>
              )}

              {isTrainPassing && (
                <div
                  className="train-passing-visual"
                  role="img"
                  aria-label="열차가 정차하지 않고 통과하고 있습니다"
                >
                  <div
                    className="train-passing-track"
                    aria-hidden="true"
                  >
                    <span className="train-passing-line" />
                    <span className="train-passing-arrow">
                      →
                    </span>
                    <span className="train-passing-line" />
                  </div>

                  <strong className="train-passing-progress">
                    정차 없이 통과
                  </strong>
                </div>
              )}
            </section>

            <section className="attention-action">
              <span className="message-kicker">
                안전을 위해
              </span>

              <p
                className={`dynamic-support ${supportingTextClass(
                  announcement.display
                    .support,
                )}`}
              >
                {
                  announcement.display
                    .support
                }
              </p>
            </section>
          </div>
        ) : isTrainBreakdown ? (
          <div className="train-breakdown-layout">
            <section className="train-breakdown-context">
              <span className="message-kicker train-breakdown-kicker">
                현재 상황
              </span>

              <p className="dynamic-lead">
                {
                  announcement.display
                    .lead
                }
              </p>

              <p
                className={`dynamic-conclusion ${dynamicConclusionClass(
                  announcement.display
                    .conclusion,
                )}`}
              >
                {
                  announcement.display
                    .conclusion
                }
              </p>

              <div
                className="train-breakdown-visual"
                role="img"
                aria-label="열차가 고장으로 인해 잠시 정차 중입니다"
              >
                <span className="train-breakdown-line" />

                <span
                  className="train-breakdown-stop-mark"
                  aria-hidden="true"
                >
                  <i />
                  <i />
                </span>

                <span className="train-breakdown-line" />
              </div>

              <strong className="train-breakdown-status">
                일시 정차
              </strong>
            </section>

            <section className="train-breakdown-action">
              <span className="message-kicker">
                승객 안내
              </span>

              <p
                className={`dynamic-support ${supportingTextClass(
                  announcement.display
                    .support,
                )}`}
              >
                {
                  announcement.display
                    .support
                }
              </p>
            </section>
          </div>
        ) : isRestrictedItems ? (
          <div className="restricted-items-layout">
            <section className="restricted-items-context">
              <span className="message-kicker restricted-items-kicker">
                반입 제한 안내
              </span>

              <p className="dynamic-lead">
                {
                  announcement.display
                    .lead
                }
              </p>

              <p
                className={`dynamic-conclusion ${dynamicConclusionClass(
                  announcement.display
                    .conclusion,
                )}`}
              >
                {
                  announcement.display
                    .conclusion
                }
              </p>

              <div
                className="restricted-items-visual"
                role="img"
                aria-label="리튬 배터리 이동수단과 대용량 리튬 배터리는 역과 열차 내 반입이 제한됩니다"
              >
                <div className="restricted-items-source">
                  <span className="restricted-items-source-label">
                    제한 대상
                  </span>

                  <strong>
                    리튬 배터리 이동수단
                  </strong>

                  <strong>
                    대용량 리튬 배터리
                  </strong>
                </div>

                <div
                  className="restricted-items-barrier"
                  aria-hidden="true"
                >
                  <span />
                  <span />
                </div>

                <div className="restricted-items-target">
                  <strong>
                    역 · 열차
                  </strong>

                  <span>
                    반입 제한
                  </span>
                </div>
              </div>
            </section>

            <section className="restricted-items-action">
              <span className="message-kicker">
                이용 안내
              </span>

              <p
                className={`dynamic-support ${supportingTextClass(
                  announcement.display
                    .support,
                )}`}
              >
                {
                  announcement.display
                    .support
                }
              </p>

              <div className="restricted-items-meta">
                <span>
                  화재 사고 예방
                </span>

                <strong>
                  2026.07.01 시행
                </strong>
              </div>
            </section>
          </div>
        ) : (
          /*
            ================================================
            일반

            상황
            ↓
            핵심 정보
            ↓
            추가 안내
            ================================================
          */
          <div className="dynamic-caption dynamic-caption-general">
            <p className="dynamic-lead">
              {
                announcement.display
                  .lead
              }
            </p>

            <div className="general-conclusion-zone">
              <p
                className={`dynamic-conclusion ${dynamicConclusionClass(
                  announcement.display
                    .conclusion,
                )}`}
              >
                {
                  announcement.display
                    .conclusion
                }
              </p>
            </div>

            <p
              className={`dynamic-support ${supportingTextClass(
                announcement.display
                  .support,
              )}`}
            >
              {
                announcement.display
                  .support
              }
            </p>
          </div>
        )
      ) : (
        <p
          className={`focus-message ${textLengthClass(
            announcement.simplified,
          )}`}
        >
          {
            announcement.simplified
          }
        </p>
      )}
    </article>
  )
}


/* =========================================================
   INVALID ROUTE
   ========================================================= */

function InvalidStationPage() {
  return (
    <main className="invalid-page">
      <span
        className="invalid-icon"
        aria-hidden="true"
      >
        QR
      </span>

      <h1>
        안내 페이지를
        <br />
        열 수 없습니다
      </h1>

      <p>
        역에 설치된 QR 코드를
        다시 스캔해 주세요.
      </p>

      <button
        type="button"
        onClick={() =>
          location.reload()
        }
      >
        다시 확인
      </button>
    </main>
  )
}


/* =========================================================
   WAITING

   헤더에서 이미 연결 상태를 알려주므로
   "안내 시스템 정상 작동 중" 같은 중복 정보 제거.
   ========================================================= */

function WaitingPanel() {
  return (
    <section
      className="waiting-panel"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="waiting-hero">
        <h2 className="waiting-title">
          <span>현재 안내방송이</span>
          <span>없습니다</span>
        </h2>

        <div className="waiting-bottom">
          <p className="waiting-description">
            새로운 안내방송이 시작되면
            <br />
            자막과 필요한 안내를 바로 보여드립니다.
          </p>

          <div
            className="waiting-character-wrap"
            aria-hidden="true"
          >
            <img
              className="waiting-character"
              src={`${import.meta.env.BASE_URL}KT_dinjae_character.png`}
              alt=""
              draggable="false"
              onError={(event) => {
                event.currentTarget.hidden = true
              }}
            />
          </div>
        </div>
      </div>
    </section>
  )
}


/* =========================================================
   STT TRANSCRIPT
   기존 로직 유지
   ========================================================= */

function appendTranscript(
  previous: string,
  next: string,
): string {
  const segment =
    next.trim()

  if (
    !segment ||
    previous.endsWith(
      segment,
    )
  ) {
    return previous
  }

  return `${previous} ${segment}`.trim()
}


function liveTranscriptTarget(
  committed: string,
  interim: string,
): string {
  const stable =
    committed.trim()

  const current =
    interim.trim()

  if (
    stable &&
    current.startsWith(
      stable,
    )
  ) {
    return current
  }

  return [
    stable,
    current,
  ]
    .filter(Boolean)
    .join(' ')
}


function advanceTranscriptReveal(
  visible: string,
  target: string,
): string {
  if (
    visible === target
  ) {
    return visible
  }

  const shown = [
    ...visible,
  ]

  const received = [
    ...target,
  ]

  let commonLength = 0

  while (
    commonLength <
      shown.length &&
    commonLength <
      received.length &&
    shown[commonLength] ===
      received[
        commonLength
      ]
  ) {
    commonLength += 1
  }

  if (
    commonLength <
    shown.length
  ) {
    return shown
      .slice(
        0,
        commonLength,
      )
      .join('')
  }

  const remaining =
    received.length -
    shown.length

  const step =
    remaining > 28
      ? 3
      : remaining > 12
        ? 2
        : 1

  return received
    .slice(
      0,
      shown.length +
        step,
    )
    .join('')
}


function useProgressiveTranscript(
  target: string,
): string {
  const [
    visible,
    setVisible,
  ] = useState('')

  useEffect(() => {
    if (!target) {
      setVisible('')
      return
    }

    const reduceMotion =
      window
        .matchMedia(
          '(prefers-reduced-motion: reduce)',
        )
        .matches

    if (
      reduceMotion ||
      document.hidden
    ) {
      setVisible(target)
      return
    }

    const timer =
      window.setInterval(
        () => {
          setVisible(
            (current) => {
              const next =
                advanceTranscriptReveal(
                  current,
                  target,
                )

              if (
                next === target
              ) {
                window.clearInterval(
                  timer,
                )
              }

              return next
            },
          )
        },
        42,
      )

    return () =>
      window.clearInterval(
        timer,
      )
  }, [target])

  return visible
}


/* =========================================================
   STREAMING CAPTION
   ========================================================= */

function StreamingCaption({
  committed,
  interim,
}: {
  committed: string
  interim: string
}) {
  const target =
    liveTranscriptTarget(
      committed,
      interim,
    )

  const visible =
    useProgressiveTranscript(
      target,
    )

  if (!target) {
    return null
  }

  return (
    <section
      className="streaming-caption"
      aria-label="실시간 자막 인식 중"
    >
      <div className="streaming-status">

        <span
          className="streaming-dot"
          aria-hidden="true"
        />

        <strong>
          방송 인식 중
        </strong>

        <span className="streaming-unconfirmed">
          확정 전
        </span>

      </div>


      <div className="streaming-content">

        <span className="streaming-eyebrow">
          지금 들리는 방송
        </span>

        <p
          className="streaming-text"
          data-stream-target={
            target
          }
          aria-hidden="true"
        >
          {visible}

          <span
            className="streaming-caret"
            aria-hidden="true"
          />
        </p>

      </div>


      <p
        className="streaming-help"
        aria-hidden="true"
      >
        방송 분석이 완료되면
        필요한 내용만 정리한
        안내 화면으로 바뀝니다.
      </p>


      <span
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {target}
      </span>

    </section>
  )
}


function announcementIdentity(
  announcement: Announcement,
): string {
  return [
    announcement.id ?? '',
    announcement.session_id ?? '',
    announcement.ts,
    announcement.original,
  ].join('|')
}


function prependAnnouncement(
  previous: Announcement[],
  announcement: Announcement,
): Announcement[] {
  const identity =
    announcementIdentity(
      announcement,
    )

  return [
    announcement,
    ...previous.filter(
      (item) =>
        announcementIdentity(
          item,
        ) !== identity,
    ),
  ].slice(0, 20)
}


/* =========================================================
   HISTORY
   ========================================================= */

function historySummary(
  announcement: Announcement,
): string {
  const label =
    announcement.label ??
    announcement.category

  const summaries:
    Record<string, string> = {
      '열차 화재':
        '입과 코를 막고 신속히 대피하세요',
      '리튬 배터리 반입 제한':
        '역·열차 내 반입이 제한됩니다',
      '열차 통과':
        '우리 역을 통과합니다',
      '열차 일시 정차':
        '열차 고장으로 잠시 정차 중입니다',
      '출입문 닫힘':
        '출입문이 닫힙니다',
      '발빠짐 주의':
        '열차와 승강장 사이가 넓습니다',
      '열차 진입':
        '열차가 들어오고 있습니다',
    }

  if (summaries[label]) {
    return summaries[label]
  }

  if (
    announcement.display
      ?.conclusion
  ) {
    return (
      announcement.display
        .conclusion
        .replace(/\n/g, ' ')
    )
  }

  return (
    announcement.simplified
  )
}


function History({
  stationName,
  announcements,
  onSelect,
  disabled = false,
}: {
  stationName: string
  announcements: Announcement[]
  onSelect: (
    announcement: Announcement,
  ) => void
  disabled?: boolean
}) {
  if (
    announcements.length === 0
  ) {
    return null
  }

  return (
    <section
      className="history"
      aria-label={`${stationName} 지난 안내`}
    >
      <details className="history-disclosure">
        <summary>
          <span className="history-summary-copy">
            <strong>
              지난 안내
            </strong>

            <span>
              {announcements.length}
              건
            </span>
          </span>

          <span
            className="history-summary-action"
            aria-hidden="true"
          >
            보기
          </span>
        </summary>

        <div className="history-list">
          {announcements.map(
            (announcement) => (
              <button
                key={announcementIdentity(
                  announcement,
                )}
                type="button"
                className="history-card history-card-button"
                data-severity={
                  announcement.severity
                }
                onClick={() =>
                  onSelect(
                    announcement,
                  )
                }
                disabled={disabled}
                aria-label={`${announcement.label ?? announcement.category} 지난 안내 상세 보기`}
              >
                <div className="history-head">
                  <SituationBadge
                    announcement={
                      announcement
                    }
                  />

                  <div className="history-meta">
                    <time
                      dateTime={new Date(
                        announcement.ts,
                      ).toISOString()}
                    >
                      {formatTime(
                        announcement.ts,
                      )}
                    </time>

                    <span
                      className="history-chevron"
                      aria-hidden="true"
                    >
                      ›
                    </span>
                  </div>
                </div>

                <p
                  className="history-summary-text"
                  aria-label={
                    announcement.simplified
                  }
                >
                  {historySummary(
                    announcement,
                  )}
                </p>
              </button>
            ),
          )}
        </div>
      </details>
    </section>
  )
}


/* =========================================================
   HISTORY DETAIL NAVIGATION
   ========================================================= */

function HistoryDetailBar({
  hasCurrent,
  onReturn,
}: {
  hasCurrent: boolean
  onReturn: () => void
}) {
  return (
    <div
      className="history-detail-bar"
      role="navigation"
      aria-label="지난 안내 상세 보기"
    >
      <button
        type="button"
        className="history-return-button"
        onClick={onReturn}
      >
        <span aria-hidden="true">
          ←
        </span>
        현재 안내로
      </button>

      <span className="history-detail-status">
        {hasCurrent
          ? '현재 방송 있음'
          : '현재 방송 없음'}
      </span>
    </div>
  )
}


/* =========================================================
   DEMO BOTTOM SHEET

   /demo 화면은 승객 화면과 동일하게 유지하고,
   우측 상단 "시연" 버튼으로만 테스트 음원을 연다.
   ========================================================= */

function DemoSheet({
  open,
  samples,
  selectedSample,
  busy,
  notice,
  onClose,
  onPlay,
}: {
  open: boolean
  samples: DemoSample[]
  selectedSample: string | null
  busy: boolean
  notice: string
  onClose: () => void
  onPlay: (
    name: string,
  ) => void
}) {
  if (!open) {
    return null
  }

  return (
    <div
      className="demo-sheet-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (
          event.target ===
          event.currentTarget
        ) {
          onClose()
        }
      }}
    >
      <section
        className="demo-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="demo-sheet-title"
      >
        <div
          className="demo-sheet-handle"
          aria-hidden="true"
        />

        <header className="demo-sheet-head">
          <div>
            <span className="demo-project-label">
              KT 디지털인재장학생 · LIVE DEMO
            </span>

            <h2 id="demo-sheet-title">
              시연할 안내방송
            </h2>

            <p>
              원하는 안내방송을 선택하면 창이 닫히고,
              실제 승객 화면이 해당 상황으로 바뀝니다.
            </p>
          </div>

          <button
            type="button"
            className="demo-sheet-close"
            onClick={onClose}
            aria-label="시연 창 닫기"
          >
            ×
          </button>
        </header>

        {notice && (
          <p
            className="demo-sheet-notice"
            role="status"
          >
            {notice}
          </p>
        )}

        <div className="demo-sheet-list">
          {samples.map(
            (sample) => {
              const active =
                selectedSample ===
                sample.name

              return (
                <button
                  key={sample.name}
                  type="button"
                  className="demo-sheet-sample"
                  aria-pressed={active}
                  onClick={() =>
                    onPlay(
                      sample.name,
                    )
                  }
                  disabled={busy}
                >
                  <span
                    className="demo-sheet-play-icon"
                    aria-hidden="true"
                  >
                    ▶
                  </span>

                  <span className="demo-sheet-sample-copy">
                    <strong>
                      {sample.title}
                    </strong>

                    <small>
                      {active && busy
                        ? '현재 재생 중'
                        : sample.source}
                    </small>
                  </span>

                  <span
                    className="demo-sheet-arrow"
                    aria-hidden="true"
                  >
                    ›
                  </span>
                </button>
              )
            },
          )}
        </div>
      </section>
    </div>
  )
}


/* =========================================================
   STATION PAGE
   ========================================================= */

function StationPage({
  station,
}: {
  station: StationPageContext
}) {
  const [
    announcements,
    setAnnouncements,
  ] =
    useState<
      Announcement[]
    >([])

  const [
    currentAnnouncement,
    setCurrentAnnouncement,
  ] =
    useState<
      Announcement | null
    >(null)

  const [
    viewingHistory,
    setViewingHistory,
  ] =
    useState<
      Announcement | null
    >(null)

  const [
    interim,
    setInterim,
  ] =
    useState('')

  const [
    committedTranscript,
    setCommittedTranscript,
  ] =
    useState('')

  const [
    isRecognizing,
    setIsRecognizing,
  ] =
    useState(false)

  const [
    selectedSample,
    setSelectedSample,
  ] =
    useState<
      string | null
    >(null)

  const [
    selectedAudioSrc,
    setSelectedAudioSrc,
  ] =
    useState<
      string | null
    >(null)

  const [
    audioPlaybackId,
    setAudioPlaybackId,
  ] =
    useState(0)

  const [
    localPlaying,
    setLocalPlaying,
  ] =
    useState(false)

  const [
    demoNotice,
    setDemoNotice,
  ] =
    useState('')

  const [
    demoSheetOpen,
    setDemoSheetOpen,
  ] =
    useState(false)

  const [
    demoDuration,
    setDemoDuration,
  ] =
    useState(0)

  const [
    demoCurrentTime,
    setDemoCurrentTime,
  ] =
    useState(0)

  const [
    connectionState,
    setConnectionState,
  ] =
    useState<ConnectionState>(
      'connecting',
    )

  const wsRef =
    useRef<
      WebSocket | null
    >(null)

  const liveSessionRef =
    useRef<
      string | null
    >(null)

  const demoFinishTimerRef =
    useRef<
      number | null
    >(null)

  const isDemo =
    station.mode ===
    'demo'

  const clearDemoFinishTimer =
    () => {
      if (
        demoFinishTimerRef.current !==
        null
      ) {
        window.clearTimeout(
          demoFinishTimerRef.current,
        )

        demoFinishTimerRef.current =
          null
      }
    }

  useEffect(() => {
    return () => {
      if (
        demoFinishTimerRef.current !==
        null
      ) {
        window.clearTimeout(
          demoFinishTimerRef.current,
        )
      }
    }
  }, [])

  useEffect(() => {
    if (!demoSheetOpen) {
      return
    }

    const onKeyDown = (
      event: KeyboardEvent,
    ) => {
      if (event.key === 'Escape') {
        setDemoSheetOpen(
          false,
        )
      }
    }

    window.addEventListener(
      'keydown',
      onKeyDown,
    )

    return () =>
      window.removeEventListener(
        'keydown',
        onKeyDown,
      )
  }, [demoSheetOpen])

  /* =======================================================
     SERVER

     /demo  : 로컬 WAV + 사전 정의 화면
     /stations : WebSocket + 실제 AI 결과
     ======================================================= */

  useEffect(() => {
    setConnectionState(
      'connecting',
    )

    document.title =
      isDemo
        ? `${station.name} 음성 데모`
        : `${station.name} 안내방송`

    if (isDemo) {
      setConnectionState(
        'connected',
      )

      return
    }

    let closed = false

    function connect() {
      const proto =
        location.protocol ===
        'https:'
          ? 'wss'
          : 'ws'

      const ws =
        new WebSocket(
          `${proto}://${location.host}/ws?station_id=${encodeURIComponent(
            station.id,
          )}`,
        )

      wsRef.current = ws

      ws.onopen = () => {
        if (!closed) {
          setConnectionState(
            'connected',
          )
        }
      }

      ws.onclose = () => {
        if (!closed) {
          setConnectionState(
            'reconnecting',
          )

          setTimeout(
            connect,
            1500,
          )
        }
      }

      ws.onmessage = (
        event,
      ) => {
        let serverEvent: ServerEvent

        try {
          serverEvent =
            JSON.parse(
              event.data,
            ) as ServerEvent
        } catch {
          return
        }

        if (
          typeof serverEvent.device_id ===
            'string' &&
          serverEvent.device_id !==
            station.id
        ) {
          return
        }

        /* -------------------------------------------------
           STT
           ------------------------------------------------- */

        if (
          serverEvent.type ===
            'stt-interim' ||
          serverEvent.type ===
            'stt-final'
        ) {
          const sessionKey =
            typeof serverEvent.session_id ===
              'string'
              ? `session:${serverEvent.session_id}`
              : liveSessionRef.current

          if (
            sessionKey &&
            liveSessionRef.current !==
              sessionKey
          ) {
            liveSessionRef.current =
              sessionKey

            setCommittedTranscript(
              '',
            )

            setInterim('')

            setCurrentAnnouncement(
              null,
            )
          }

          /*
            새 방송이 시작되면 과거 안내 상세 화면보다
            현재 방송을 우선한다.
          */
          setViewingHistory(
            null,
          )

          setIsRecognizing(
            true,
          )
        }

        if (
          serverEvent.type ===
          'stt-interim'
        ) {
          setInterim(
            String(
              serverEvent.text ??
              '',
            ),
          )
        }

        if (
          serverEvent.type ===
          'stt-final'
        ) {
          setCommittedTranscript(
            (previous) =>
              appendTranscript(
                previous,
                String(
                  serverEvent.text ??
                  '',
                ),
              ),
          )

          setInterim('')
        }

        /* -------------------------------------------------
           STATUS
           ------------------------------------------------- */

        if (
          serverEvent.type ===
          'status'
        ) {
          const nextPlaying =
            typeof serverEvent.playing ===
              'string'
              ? serverEvent.playing
              : null

          if (nextPlaying) {
            const sessionKey =
              `sample:${nextPlaying}`

            if (
              liveSessionRef.current !==
              sessionKey
            ) {
              liveSessionRef.current =
                sessionKey

              setCommittedTranscript(
                '',
              )

              setInterim('')
            }

            setIsRecognizing(
              true,
            )
          }

          /*
            백엔드가 방송 종료를 status.playing = null 로
            알려주는 경우 현재 안내를 종료한다.
            해당 안내는 announcements에 남아 History로 이동한다.
          */
          if (
            serverEvent.playing ===
            null
          ) {
            setLocalPlaying(
              false,
            )

            setCurrentAnnouncement(
              null,
            )

            setIsRecognizing(
              false,
            )

            setCommittedTranscript(
              '',
            )

            setInterim('')
          }

          if (
            typeof serverEvent.error ===
            'string'
          ) {
            setIsRecognizing(
              false,
            )

            setCurrentAnnouncement(
              null,
            )

            setCommittedTranscript(
              '',
            )

            setInterim('')

            setDemoNotice(
              `분석 오류: ${serverEvent.error}`,
            )
          }
        }

        /* -------------------------------------------------
           ANNOUNCEMENT
           ------------------------------------------------- */

        if (
          serverEvent.type ===
          'announcement'
        ) {
          const incoming =
            serverEvent as unknown as Announcement

          setDemoNotice('')

          setIsRecognizing(
            false,
          )

          setCommittedTranscript(
            '',
          )

          setInterim('')

          setViewingHistory(
            null,
          )

          setCurrentAnnouncement(
            incoming,
          )

          /*
            History 저장소에는 바로 보관하되,
            현재 진행 중인 안내는 아래 derived state에서
            목록에서 잠시 제외한다.
          */
          setAnnouncements(
            (previous) =>
              prependAnnouncement(
                previous,
                incoming,
              ),
          )
        }

        /* -------------------------------------------------
           FILTERED
           ------------------------------------------------- */

        if (
          serverEvent.type ===
          'filtered'
        ) {
          setIsRecognizing(
            false,
          )

          setCurrentAnnouncement(
            null,
          )

          setCommittedTranscript(
            '',
          )

          setInterim('')

          setDemoNotice(
            '이 음성은 안내방송으로 분류되지 않았습니다.',
          )
        }

        /* -------------------------------------------------
           SESSION ERROR
           ------------------------------------------------- */

        if (
          serverEvent.type ===
          'session-error'
        ) {
          setIsRecognizing(
            false,
          )

          setCurrentAnnouncement(
            null,
          )

          setCommittedTranscript(
            '',
          )

          setInterim('')

          setDemoNotice(
            '음성 처리 중 오류가 발생했습니다.',
          )
        }
      }
    }

    connect()

    return () => {
      closed = true

      const activeSocket =
        wsRef.current

      if (
        activeSocket?.readyState ===
        WebSocket.CONNECTING
      ) {
        activeSocket.onopen =
          () =>
            activeSocket.close()
      } else {
        activeSocket?.close()
      }
    }
  }, [
    isDemo,
    station.id,
    station.name,
  ])

  /* =======================================================
     DEMO PLAY

     버튼 클릭
     → 실제 WAV 재생
     → 해당 승객 화면 즉시 표시
     → 음성 종료 후 1.2초 유지
     → History 저장
     → Waiting 복귀
     ======================================================= */

  const play = (
    name: string,
  ) => {
    if (localPlaying) {
      return
    }

    const sample =
      DEMO_SAMPLES.find(
        (item) =>
          item.name === name,
      )

    const demoAnnouncement =
      createDemoAnnouncement(
        name,
        station.id,
      )

    if (
      !sample ||
      !demoAnnouncement
    ) {
      setDemoNotice(
        '해당 데모 음성을 찾을 수 없습니다.',
      )

      return
    }

    clearDemoFinishTimer()

    setDemoSheetOpen(
      false,
    )

    setDemoDuration(0)
    setDemoCurrentTime(0)

    setViewingHistory(
      null,
    )

    setSelectedSample(
      name,
    )

    setSelectedAudioSrc(
      sample.audio,
    )

    setAudioPlaybackId(
      (current) =>
        current + 1,
    )

    setCurrentAnnouncement(
      demoAnnouncement,
    )

    setDemoNotice('')

    setLocalPlaying(
      true,
    )

    setCommittedTranscript(
      '',
    )

    setInterim('')

    setIsRecognizing(
      false,
    )
  }

  const finishDemoPlayback =
    () => {
      if (!isDemo) {
        setLocalPlaying(
          false,
        )

        return
      }

      clearDemoFinishTimer()

      const finishedAnnouncement =
        currentAnnouncement

      /*
        오디오가 끝난 순간 카운트다운은 종료한다.
        현재 안내 화면은 0.8초만 더 유지한 뒤
        History로 이동하고 Waiting으로 복귀한다.
      */
      setLocalPlaying(
        false,
      )

      setDemoDuration(0)
      setDemoCurrentTime(0)

      demoFinishTimerRef.current =
        window.setTimeout(
          () => {
            if (
              finishedAnnouncement
            ) {
              setAnnouncements(
                (previous) =>
                  prependAnnouncement(
                    previous,
                    finishedAnnouncement,
                  ),
              )
            }

            setCurrentAnnouncement(
              (current) => {
                if (
                  !current ||
                  !finishedAnnouncement
                ) {
                  return current
                }

                return (
                  announcementIdentity(
                    current,
                  ) ===
                  announcementIdentity(
                    finishedAnnouncement,
                  )
                    ? null
                    : current
                )
              },
            )

            setSelectedSample(
              null,
            )

            setSelectedAudioSrc(
              null,
            )

            demoFinishTimerRef.current =
              null
          },
          800,
        )
    }

  const handleAudioError =
    () => {
      clearDemoFinishTimer()

      setLocalPlaying(
        false,
      )

      setDemoDuration(0)
      setDemoCurrentTime(0)

      setCurrentAnnouncement(
        null,
      )

      setSelectedSample(
        null,
      )

      setSelectedAudioSrc(
        null,
      )

      setDemoNotice(
        '음성 파일을 재생할 수 없습니다.',
      )

      setDemoSheetOpen(
        true,
      )
    }

  /* =======================================================
     DERIVED STATE
     ======================================================= */

  const hasLiveTranscript =
    Boolean(
      committedTranscript.trim() ||
      interim.trim(),
    )

  const showingLiveTranscript =
    !viewingHistory &&
    isRecognizing &&
    hasLiveTranscript

  const displayedAnnouncement =
    viewingHistory ??
    currentAnnouncement ??
    undefined

  const liveState: LiveState =
    showingLiveTranscript
      ? 'streaming'
      : displayedAnnouncement
        ? 'announcement'
        : 'waiting'

  const activeSeverity =
    liveState ===
      'announcement' &&
    displayedAnnouncement
      ? displayedAnnouncement.severity
      : undefined

  /*
    현재 안내는 History 목록에서 숨긴다.
    방송이 끝나 currentAnnouncement가 null이 되면
    자동으로 지난 안내 목록에 나타난다.
  */
  const history =
    currentAnnouncement
      ? announcements.filter(
          (announcement) =>
            announcementIdentity(
              announcement,
            ) !==
            announcementIdentity(
              currentAnnouncement,
            ),
        )
      : announcements

  const featuredSamples =
    DEMO_SAMPLES

  const busy =
    localPlaying

  const hasCurrent =
    showingLiveTranscript ||
    currentAnnouncement !==
      null

  const demoRemainingSeconds =
    localPlaying &&
    Number.isFinite(
      demoDuration,
    ) &&
    demoDuration > 0
      ? Math.max(
          0,
          Math.ceil(
            demoDuration -
              demoCurrentTime,
          ),
        )
      : null

  const demoRemaining =
    demoRemainingSeconds ===
    null
      ? localPlaying
        ? '--:--'
        : null
      : `${String(
          Math.floor(
            demoRemainingSeconds /
              60,
          ),
        ).padStart(
          2,
          '0',
        )}:${String(
          demoRemainingSeconds %
            60,
        ).padStart(
          2,
          '0',
        )}`

  /* =======================================================
     RENDER
     ======================================================= */

  return (
    <div
      className="app-shell"
      data-mode={
        isDemo
          ? 'demo'
          : 'passenger'
      }
      data-live-state={
        liveState
      }
      data-live-severity={
        activeSeverity ??
        'none'
      }
    >
      <StationHeader
        stationName={
          station.name
        }
        connectionState={
          connectionState
        }
        demo={
          isDemo
        }
        demoPlaying={
          isDemo &&
          localPlaying
        }
        demoRemaining={
          demoRemaining
        }
        onOpenDemo={
          isDemo
            ? () =>
                setDemoSheetOpen(
                  true,
                )
            : undefined
        }
      />

      {isDemo && (
        <audio
          key={`${selectedAudioSrc ?? 'no-audio'}-${audioPlaybackId}`}
          className="demo-audio-engine"
          autoPlay={Boolean(
            selectedAudioSrc,
          )}
          preload="metadata"
          src={
            selectedAudioSrc ??
            undefined
          }
          onLoadedMetadata={(event) => {
            const duration =
              event.currentTarget.duration

            setDemoDuration(
              Number.isFinite(
                duration,
              )
                ? duration
                : 0,
            )
          }}
          onTimeUpdate={(event) =>
            setDemoCurrentTime(
              event.currentTarget
                .currentTime,
            )
          }
          onEnded={
            finishDemoPlayback
          }
          onError={
            handleAudioError
          }
        />
      )}

      <main className="station-main passenger-main">
        <section
          className="live-stage"
          data-current-label={
            displayedAnnouncement?.label ??
            displayedAnnouncement?.category ??
            'none'
          }
          aria-label="실시간 안내"
        >
          {viewingHistory && (
            <HistoryDetailBar
              hasCurrent={
                hasCurrent
              }
              onReturn={() =>
                setViewingHistory(
                  null,
                )
              }
            />
          )}

          {showingLiveTranscript ? (
            <StreamingCaption
              committed={
                committedTranscript
              }
              interim={
                interim
              }
            />
          ) : displayedAnnouncement ? (
            <FocusAnnouncement
              key={
                displayedAnnouncement.id ??
                displayedAnnouncement.session_id ??
                displayedAnnouncement.ts
              }
              announcement={
                displayedAnnouncement
              }
            />
          ) : (
            <WaitingPanel />
          )}
        </section>

        <History
          stationName={
            station.name
          }
          announcements={
            history
          }
          disabled={
            isDemo &&
            localPlaying
          }
          onSelect={(
            announcement,
          ) =>
            setViewingHistory(
              announcement,
            )
          }
        />
      </main>

      {isDemo && (
        <DemoSheet
          open={
            demoSheetOpen
          }
          samples={
            featuredSamples
          }
          selectedSample={
            selectedSample
          }
          busy={
            busy
          }
          notice={
            demoNotice
          }
          onClose={() =>
            setDemoSheetOpen(
              false,
            )
          }
          onPlay={(
            name,
          ) =>
            void play(
              name,
            )
          }
        />
      )}
    </div>
  )

}


/* =========================================================
   APP
   ========================================================= */

export default function App() {
  const station =
    resolveStationPage()

  return station ? (
    <StationPage
      station={
        station
      }
    />
  ) : (
    <InvalidStationPage />
  )
}