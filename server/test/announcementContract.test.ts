import { describe, expect, it } from 'vitest'
import {
  ANNOUNCEMENT_CATEGORIES,
  ANNOUNCEMENT_CATEGORY_DEFINITIONS,
  ANNOUNCEMENT_SEVERITIES,
  isAnnouncementCategory,
  isAnnouncementSeverity,
} from '@live-notice/contracts'
import { parseClassification } from '../src/pipeline/classify.js'

describe('announcement classification contract', () => {
  it('keeps the agreed station-facing categories and their contents in one runtime contract', () => {
    expect(ANNOUNCEMENT_CATEGORIES).toEqual([
      '열차 통과', '열차 진입', '운행 변경', '일반 안내', '긴급 안내',
    ])
    expect(ANNOUNCEMENT_CATEGORY_DEFINITIONS).toEqual({
      '열차 통과': { includes: ['무정차 열차 접근', '안전선 안쪽 이동'] },
      '열차 진입': { includes: ['행선지', '열차 접근', '승강장 간격·발빠짐 주의'] },
      '운행 변경': { includes: ['지연', '신호 대기', '운행 중단', '승강장 변경'] },
      '일반 안내': { includes: ['반입 제한', '폭염', '이용수칙', '역사 시설 안내'] },
      '긴급 안내': { includes: ['화재', '대피', '그 밖의 실제 긴급방송'] },
    })
  })

  it('rejects category drift while preserving the independent severity enum', () => {
    expect(isAnnouncementCategory('열차 통과')).toBe(true)
    expect(isAnnouncementCategory('무정차')).toBe(false)
    expect(ANNOUNCEMENT_SEVERITIES).toEqual(['일반', '주의', '긴급'])
    expect(isAnnouncementSeverity('긴급')).toBe(true)
    expect(isAnnouncementSeverity('높음')).toBe(false)
  })

  it('validates the classifier payload before it reaches storage or WebSocket clients', () => {
    expect(parseClassification({
      is_announcement: true,
      category: '일반 안내',
      label: '반입 제한',
      severity: '일반',
      simplified: '전동킥보드는 역사와 열차에 반입할 수 없습니다.',
      display: { lead: '역사와 열차에는', conclusion: '반입할 수 없습니다', support: '전동킥보드 등 리튬배터리 이동수단' },
    })).toMatchObject({
      category: '일반 안내', label: '반입 제한',
      display: { lead: '역사와 열차에는', conclusion: '반입할 수 없습니다', support: '전동킥보드 등 리튬배터리 이동수단' },
    })

    expect(() => parseClassification({
      is_announcement: true,
      category: '무정차',
      label: '열차 통과',
      severity: '주의',
      simplified: '이 열차는 정차하지 않습니다.',
      display: { lead: '지금 들어오는 열차는', conclusion: '정차하지 않습니다', support: '안전선 안으로 이동하세요' },
    })).toThrow('분류 결과 형식 오류')
  })

  it('repairs missing sentence-boundary spacing before passenger display', () => {
    expect(parseClassification({
      is_announcement: true,
      category: '열차 통과',
      label: '급행 열차 안내',
      severity: '주의',
      simplified: '이 열차는 세류역에 서지 않습니다.세류역에 가려면 다음 열차를 타세요.',
      display: { lead: '지금 들어오는 급행 열차는', conclusion: '세류역에 서지 않습니다', support: '세류역은 다음 일반 열차를 타세요' },
    }).simplified).toBe('이 열차는 세류역에 서지 않습니다. 세류역에 가려면 다음 열차를 타세요.')
  })

  it('rejects announcements that cannot stand alone without the source transcript', () => {
    expect(() => parseClassification({
      is_announcement: true,
      category: '열차 통과',
      label: '열차 통과',
      severity: '주의',
      simplified: '이 열차는 정차하지 않습니다.',
      display: { lead: '지금 들어오는 열차는', conclusion: '', support: '안전선 안으로 이동하세요' },
    })).toThrow('분류 결과 형식 오류')
  })
})
