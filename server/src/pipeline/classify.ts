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
  display?: {
    lead: string
    conclusion: string
    support: string
  }
}

const CATEGORY_GUIDE = ANNOUNCEMENT_CATEGORIES
  .map((category) => `${category}(${ANNOUNCEMENT_CATEGORY_DEFINITIONS[category].includes.join(', ')})`)
  .join(' | ')

const SYSTEM_PROMPT = `당신은 지하철/철도역 안내방송을 청각장애인·시청각장애인에게 텍스트로 전달하는 시스템의 분류기입니다.
음성인식(STT)으로 변환된 텍스트를 받아 다음을 판단하세요.

1. is_announcement: 역사 안내방송인지 여부. 승객 간 대화, 잡담, 소음이 잘못 인식된 텍스트는 false.
2. category: ${CATEGORY_GUIDE}
   접근 중인 열차가 해당 역에 정차하지 않는다고 명시되면, "들어오고 있습니다"라는 표현이 있어도 반드시 "열차 통과"로 분류하세요.
3. label: 승객 화면에 표시할 구체적인 상황명. 2~12자의 명사형으로 작성. 예: 열차 통과, 열차 진입, 운행 지연, 반입 제한, 화재 대피.
4. severity: 일반 | 주의(놓치면 이동에 지장) | 긴급(즉시 안전 행동이 필요한 위협)
5. simplified: 입력된 STT 전체 문장을 어미·단어·문장 순서까지 그대로 복사. 요약·교정·쉬운 말 변환·어투 변경 금지.
6. display: 확정 안내 카드가 원문 없이도 이해되도록 다음 세 단계로 구조화.
   - lead: STT 원문에서 그대로 이어지는 상황 맥락 구절
   - conclusion: STT 원문에서 그대로 이어지는 20자 이내의 핵심 결론 구절
   - support: STT 원문에서 그대로 이어지는 행동 또는 추가 정보 구절
   세 필드는 오직 STT 원문의 연속된 구절을 그대로 복사해야 합니다. 단어 추가·삭제·치환, 존댓말 어미 변경, 문법 교정, 안전 행동 추론을 금지합니다.
   방송이 "이용하시기 바랍니다"라고 말했으면 그대로 쓰고 "이용하세요"로 바꾸지 마세요. 방송에 없는 행동을 새로 만들지 마세요.

STT 텍스트는 정확하다고 가정하고 교정하지 마세요. is_announcement가 false면 label, simplified, display의 세 문자열은 모두 빈 문자열로 하세요.`

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
      display: {
        type: 'object',
        properties: {
          lead: { type: 'string', maxLength: 40, description: 'STT 원문에서 그대로 복사한 연속 구절' },
          conclusion: { type: 'string', maxLength: 20, description: 'STT 원문에서 그대로 복사한 핵심 연속 구절' },
          support: { type: 'string', maxLength: 48, description: 'STT 원문에서 그대로 복사한 행동·추가정보 연속 구절' },
        },
        required: ['lead', 'conclusion', 'support'],
      },
    },
    required: ['is_announcement', 'category', 'label', 'severity', 'simplified', 'display'],
  },
}

const client = new Anthropic()

function comparableText(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/[.,!?·…:;"'“”‘’()[\]{}]/g, '').trim()
}

export function displayUsesSourceWording(source: string, display: NonNullable<Classification['display']>): boolean {
  const comparableSource = comparableText(source)
  return [display.lead, display.conclusion, display.support]
    .every((part) => comparableSource.includes(comparableText(part)))
}

export function groundPassengerWording(source: string, classification: Classification): Classification {
  if (!classification.is_announcement) return classification
  const sourceText = source.trim()
  return {
    ...classification,
    simplified: sourceText,
    display: classification.display && displayUsesSourceWording(sourceText, classification.display)
      ? classification.display
      : undefined,
  }
}

export function parseClassification(input: unknown): Classification {
  if (!input || typeof input !== 'object') throw new Error('분류 결과 형식 오류')
  const value = input as Record<string, unknown>
  const display = value.display as Record<string, unknown> | undefined
  if (
    typeof value.is_announcement !== 'boolean'
    || !isAnnouncementCategory(value.category)
    || !isAnnouncementSeverity(value.severity)
    || typeof value.label !== 'string'
    || value.label.length > 20
    || typeof value.simplified !== 'string'
    || !display
    || typeof display.lead !== 'string'
    || typeof display.conclusion !== 'string'
    || typeof display.support !== 'string'
    || display.lead.length > 40
    || display.conclusion.length > 20
    || display.support.length > 48
    || (value.is_announcement && (!value.label.trim() || !value.simplified.trim() || !display.lead.trim() || !display.conclusion.trim() || !display.support.trim()))
    || (!value.is_announcement && (value.label !== '' || value.simplified !== '' || display.lead !== '' || display.conclusion !== '' || display.support !== ''))
  ) {
    throw new Error('분류 결과 형식 오류')
  }
  return {
    is_announcement: value.is_announcement,
    category: value.category,
    label: value.label,
    severity: value.severity,
    simplified: value.simplified.trim(),
    display: {
      lead: display.lead.trim(),
      conclusion: display.conclusion.trim(),
      support: display.support.trim(),
    },
  }
}

/** STT final 텍스트를 분류하되 승객에게 보이는 문구는 원문 어투를 보존한다. */
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
  const parsed = parseClassification(toolUse.input)
  return groundPassengerWording(text, parsed)
}
