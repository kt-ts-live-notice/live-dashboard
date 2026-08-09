import Anthropic from '@anthropic-ai/sdk'
import {
  ANNOUNCEMENT_CATEGORIES,
  ANNOUNCEMENT_CATEGORY_DEFINITIONS,
  ANNOUNCEMENT_SEVERITIES,
  isAnnouncementCategory,
  isAnnouncementSeverity,
  type AnnouncementCategory,
  type AnnouncementSeverity,
} from '@live-notice/contracts'

export type Category = AnnouncementCategory
export type Severity = AnnouncementSeverity

export interface Classification {
  is_announcement: boolean
  category: Category
  label: string
  severity: Severity
  simplified: string
}

const CATEGORY_GUIDE = ANNOUNCEMENT_CATEGORIES
  .map((category) => `${category}(${ANNOUNCEMENT_CATEGORY_DEFINITIONS[category].includes.join(', ')})`)
  .join(' | ')

const SYSTEM_PROMPT = `당신은 지하철/철도역 안내방송을 청각장애인·시청각장애인에게 텍스트로 전달하는 시스템의 분류기입니다.
음성인식(STT)으로 변환된 텍스트를 받아 다음을 판단하세요.

1. is_announcement: 역사 안내방송인지 여부. 승객 간 대화, 잡담, 소음이 잘못 인식된 텍스트는 false.
2. category: ${CATEGORY_GUIDE}
3. label: 승객 화면에 표시할 구체적인 상황명. 2~12자의 명사형으로 작성. 예: 열차 통과, 열차 진입, 운행 지연, 반입 제한, 화재 대피.
4. severity: 일반 | 주의(놓치면 이동에 지장) | 긴급(즉시 안전 행동이 필요한 위협)
5. simplified: 짧고 명확한 쉬운 문장으로 변환. 핵심 정보 + 필요한 행동 안내를 담되 유아어는 쓰지 말 것.
   예: "이번 열차는 세류역에 정차하지 않습니다" → "이 열차는 세류역에 서지 않습니다. 세류역에 가려면 타지 마세요."

STT 오인식으로 문장이 어색할 수 있으니 문맥으로 의도를 추정하세요. is_announcement가 false면 label과 simplified는 빈 문자열로 하세요.`

const CLASSIFY_TOOL: Anthropic.Tool = {
  name: 'report_classification',
  description: '안내방송 분류 결과를 보고한다',
  input_schema: {
    type: 'object',
    properties: {
      is_announcement: { type: 'boolean' },
      category: { type: 'string', enum: [...ANNOUNCEMENT_CATEGORIES] },
      label: { type: 'string', maxLength: 20 },
      severity: { type: 'string', enum: [...ANNOUNCEMENT_SEVERITIES] },
      simplified: { type: 'string' },
    },
    required: ['is_announcement', 'category', 'label', 'severity', 'simplified'],
  },
}

const client = new Anthropic()

function normalizeSentenceSpacing(text: string): string {
  return text.trim().replace(/([.!?])(?=[가-힣A-Za-z])/g, '$1 ')
}

export function parseClassification(input: unknown): Classification {
  if (!input || typeof input !== 'object') throw new Error('분류 결과 형식 오류')
  const value = input as Record<string, unknown>
  if (
    typeof value.is_announcement !== 'boolean'
    || !isAnnouncementCategory(value.category)
    || !isAnnouncementSeverity(value.severity)
    || typeof value.label !== 'string'
    || value.label.length > 20
    || typeof value.simplified !== 'string'
    || (value.is_announcement && (!value.label.trim() || !value.simplified.trim()))
    || (!value.is_announcement && (value.label !== '' || value.simplified !== ''))
  ) {
    throw new Error('분류 결과 형식 오류')
  }
  return {
    is_announcement: value.is_announcement,
    category: value.category,
    label: value.label,
    severity: value.severity,
    simplified: normalizeSentenceSpacing(value.simplified),
  }
}

/** STT final 텍스트를 분류하고 쉬운 문장으로 변환한다. context는 직전 발화들. */
export async function classify(text: string, context: string[] = []): Promise<Classification> {
  const contextBlock = context.length
    ? `[직전 발화]\n${context.join('\n')}\n\n`
    : ''
  const res = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 500,
    system: SYSTEM_PROMPT,
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: 'tool', name: 'report_classification' },
    messages: [{ role: 'user', content: `${contextBlock}[분류할 텍스트]\n${text}` }],
  })
  const toolUse = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
  if (!toolUse) throw new Error('분류 결과 없음')
  return parseClassification(toolUse.input)
}
