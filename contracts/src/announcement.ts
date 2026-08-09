export const ANNOUNCEMENT_CATEGORY_DEFINITIONS = {
  '열차 통과': {
    includes: ['무정차 열차 접근', '안전선 안쪽 이동'],
  },
  '열차 진입': {
    includes: ['행선지', '열차 접근', '승강장 간격·발빠짐 주의'],
  },
  '운행 변경': {
    includes: ['지연', '신호 대기', '운행 중단', '승강장 변경'],
  },
  '일반 안내': {
    includes: ['반입 제한', '폭염', '이용수칙', '역사 시설 안내'],
  },
  '긴급 안내': {
    includes: ['화재', '대피', '그 밖의 실제 긴급방송'],
  },
} as const

export type AnnouncementCategory = keyof typeof ANNOUNCEMENT_CATEGORY_DEFINITIONS

export const ANNOUNCEMENT_CATEGORIES = Object.freeze(
  Object.keys(ANNOUNCEMENT_CATEGORY_DEFINITIONS) as AnnouncementCategory[],
)

export const ANNOUNCEMENT_SEVERITIES = ['일반', '주의', '긴급'] as const
export type AnnouncementSeverity = typeof ANNOUNCEMENT_SEVERITIES[number]

export function isAnnouncementCategory(value: unknown): value is AnnouncementCategory {
  return typeof value === 'string' && Object.hasOwn(ANNOUNCEMENT_CATEGORY_DEFINITIONS, value)
}

export function isAnnouncementSeverity(value: unknown): value is AnnouncementSeverity {
  return typeof value === 'string' && (ANNOUNCEMENT_SEVERITIES as readonly string[]).includes(value)
}
