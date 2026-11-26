import type { OrbState } from 'thinking-orbs'
import type { AskStage } from './askSchemas'
import type { Turn } from './askReducer'
import { t } from '@/i18n'

export type StepState = 'done' | 'active' | 'pending'
export interface ThinkStep {
  key: AskStage
  name: string
  state: StepState
}

// 順序＝實際發生順序。retrieved 排在 evaluating 之前：後端已把 retrieved 的推進提前到
// 檢索開始（rerank 是整條路徑最長的靜默窗），而 agentic 的 evaluating 必然發生在第一輪
// 檢索**之後**。兩者對調前，這一格會在檢索途中亮 40 秒都不動。
const ORDER: { key: AskStage; name: string }[] = [
  { key: 'understanding', get name() { return t('lib.thinkingStages.understandingTheQuestion') } },
  { key: 'retrieved', get name() { return t('lib.thinkingStages.searchingReports') } },
  { key: 'evaluating', get name() { return t('lib.thinkingStages.assessingFollowUpSearch') } },
  { key: 'reading', get name() { return t('lib.thinkingStages.readingAndOrganizing') } },
  { key: 'searching_web', get name() { return t('lib.thinkingStages.webSupplement') } },
  { key: 'generating', get name() { return t('lib.thinkingStages.generatingTheAnswer') } },
]

export function stagesToSteps(reached: AskStage[], webUsed: boolean): ThinkStep[] {
  // evaluating 與 searching_web 皆為條件性步驟：未實際發生的流程不顯示假步驟
  const visible = ORDER.filter(
    s => (s.key !== 'searching_web' || webUsed) && (s.key !== 'evaluating' || reached.includes('evaluating'))
  )
  // 取「抵達過的最遠一步」而非最後一筆：retrieved 會送兩次（檢索前推進、檢索後補
  // count），第二筆落在 evaluating 之後，用最後一筆會讓進度倒退一格。findIndex 對
  // 不可見步驟回 -1，Math.max 自然忽略。
  const lastIdx = reached.reduce(
    (mx, key) => Math.max(mx, visible.findIndex(s => s.key === key)),
    -1
  )
  return visible.map((s, i) => ({
    key: s.key,
    name: s.name,
    state: lastIdx === -1 ? 'pending' : i < lastIdx ? 'done' : i === lastIdx ? 'active' : 'pending',
  }))
}

// 思考中的點陣球（thinking-orbs）：動畫跟著目前步驟換。排隊與還沒抵達任何步驟時是 breathing。
const ORB_STATE: Record<AskStage, OrbState> = {
  understanding: 'solving',
  retrieved: 'searching',
  evaluating: 'weaving',
  reading: 'working',
  searching_web: 'connecting',
  generating: 'composing',
}

/**
 * 進行中（排隊、思考、寫答案）的狀態文字與點陣球動畫；標頭與思考中的大球共用。
 * 後端在取得併發名額前先送 queued（web/concurrency.py）；排第一位不報名次，那只是雜訊。
 */
export function liveStatus(turn: Turn): { label: string; orb: OrbState } {
  if (turn.queuePosition !== null) {
    const pos = turn.queuePosition
    return { label: pos > 1 ? t('ask.thinkingSteps.queuedPosition', { pos }) : t('ask.thinkingSteps.queued'), orb: 'breathing' }
  }
  if (turn.phase === 'streaming') return { label: t('ask.thinkingSteps.writingTheAnswer'), orb: 'composing' }
  const active = stagesToSteps(turn.stages, turn.webUsed).find(s => s.state === 'active')
  return active
    ? { label: `${active.name}…`, orb: ORB_STATE[active.key] }
    : { label: t('ask.thinkingSteps.thinking'), orb: 'breathing' }
}
