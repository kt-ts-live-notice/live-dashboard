export interface StationSubscription {
  stationId: string | null
}

const STATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export function isValidStationId(value: string): boolean {
  return STATION_ID_PATTERN.test(value)
}

/** null은 거절할 upgrade, stationId null은 기존 전체 구독을 뜻한다. */
export function parseStationSubscription(rawUrl: string | undefined): StationSubscription | null {
  const url = new URL(rawUrl ?? '/', 'http://localhost')
  if (url.pathname !== '/ws') return null
  const stationId = url.searchParams.get('station_id')
  if (stationId === null) return { stationId: null }
  if (!isValidStationId(stationId)) return null
  return { stationId }
}

/** device_id가 없는 개발용 샘플 이벤트는 모든 구독자에게 전달한다. */
export function shouldDeliverToStation(event: Record<string, unknown>, stationId: string | null): boolean {
  if (stationId === null) return true
  return typeof event.device_id !== 'string' || event.device_id === stationId
}
