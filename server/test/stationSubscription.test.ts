import { describe, expect, it } from 'vitest'
import { parseStationSubscription, shouldDeliverToStation } from '../src/ws/stationSubscription.js'

describe('station WebSocket subscription', () => {
  it('parses station-scoped and legacy subscriptions', () => {
    expect(parseStationSubscription('/ws?station_id=station-pi-01')).toEqual({ stationId: 'station-pi-01' })
    expect(parseStationSubscription('/ws')).toEqual({ stationId: null })
  })

  it('rejects unrelated paths and unsafe station ids', () => {
    expect(parseStationSubscription('/api/ws?station_id=station-pi-01')).toBeNull()
    expect(parseStationSubscription('/ws?station_id=../../other')).toBeNull()
    expect(parseStationSubscription('/ws?station_id=')).toBeNull()
  })

  it('delivers device events only to the matching station', () => {
    const event = { type: 'announcement', device_id: 'station-pi-01' }
    expect(shouldDeliverToStation(event, 'station-pi-01')).toBe(true)
    expect(shouldDeliverToStation(event, 'station-pi-02')).toBe(false)
    expect(shouldDeliverToStation(event, null)).toBe(true)
  })

  it('keeps unscoped development sample events visible', () => {
    expect(shouldDeliverToStation({ type: 'status', playing: 'kt_89' }, 'station-pi-01')).toBe(true)
  })

  it('scopes station-tagged sample events like real device events', () => {
    const sampleEvent = { type: 'status', playing: 'kt_89', device_id: 'station-pi-01' }
    expect(shouldDeliverToStation(sampleEvent, 'station-pi-01')).toBe(true)
    expect(shouldDeliverToStation(sampleEvent, 'station-pi-02')).toBe(false)
  })
})
