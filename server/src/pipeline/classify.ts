import Anthropic from '@anthropic-ai/sdk'

export type Category = '지연' | '무정차' | '승강장변경' | '안전' | '긴급' | '일반'
export type Severity = '일반' | '주의' | '긴급'

export interface Classification {
  is_announcement: boolean
  category: Category
  severity: Severity
  simplified: string
}

const SYSTEM_PROMPT = `당신은 지하철/철도역 안내방송을 청각장애인·시청각장애인에게 텍스트로 전달하는 시스템의 분류기입니다.
음성인식(STT)으로 변환된 텍스트를 받아 다음을 판단하세요.

1. is_announcement: 역사 안내방송인지 여부. 승객 간 대화, 잡담, 소음이 잘못 인식된 텍스트는 false.
2. category: 지연(열차 지연/고장) | 무정차(통과, 급행 안내) | 승강장변경(타는 곳 변경) | 안전(안전 주의) | 긴급(화재, 대피, 사고) | 일반(그 외 안내)
3. severity: 일반 | 주의(놓치면 이동에 지장: 지연/무정차/승강장변경) | 긴급(안전 위협: 화재/대피/사고)
4. simplified: 짧고 명확한 쉬운 문장으로 변환. 핵심 정보 + 필요한 행동 안내를 담되 유아어는 쓰지 말 것.
   예: "이번 열차는 세류역에 정차하지 않습니다" → "이 열차는 세류역에 서지 않습니다. 세류역에 가려면 타지 마세요."

STT 오인식으로 문장이 어색할 수 있으니 문맥으로 의도를 추정하세요. is_announcement가 false면 simplified는 빈 문자열로 하세요.`

const CLASSIFY_TOOL: Anthropic.Tool = {
  name: 'report_classification',
  description: '안내방송 분류 결과를 보고한다',
  input_schema: {
    type: 'object',
    properties: {
      is_announcement: { type: 'boolean' },
      category: { type: 'string', enum: ['지연', '무정차', '승강장변경', '안전', '긴급', '일반'] },
      severity: { type: 'string', enum: ['일반', '주의', '긴급'] },
      simplified: { type: 'string' },
    },
    required: ['is_announcement', 'category', 'severity', 'simplified'],
  },
}

const client = new Anthropic()

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
  return toolUse.input as Classification
}
