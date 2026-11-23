import { motion, useReducedMotion } from 'motion/react'
import type { Turn } from '../../lib/askReducer'
import { HeroOrb } from './HeroOrb'
import { liveStatus } from '../../lib/thinkingStages'
import { ThinkClock } from './ThinkingSteps'
import stepStyles from './ThinkingSteps.module.css'
import styles from './ThinkingHero.module.css'

interface Props {
  turn: Turn
  /** 與標頭點陣球共用的版面 id：開始寫答案時大球縮小飛到標頭。 */
  orbLayoutId?: string
}

/**
 * 思考中的置中大球（類似語音模式）：佔滿問題下方的空間，球下面一行是目前步驟的流光文字與計時。
 * 步驟清單這時不顯示，開始寫答案後由回答上方的 ThinkingSteps 接手（收合狀態，點開看得到）。
 * 進出場由 TurnRow 的 AnimatePresence 管；減少動態時直接出現、直接消失。
 */
export function ThinkingHero({ turn, orbLayoutId }: Props) {
  const reduce = useReducedMotion()
  const { label, orb } = liveStatus(turn)
  return (
    <motion.div
      className={styles.hero}
      data-testid="thinking-hero"
      initial={reduce ? false : { opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.4, ease: [0.32, 0.72, 0, 1] }}
    >
      <motion.div layoutId={orbLayoutId} className={styles.orb}>
        <HeroOrb state={orb} />
      </motion.div>
      <div className={styles.status}>
        <span className={`${stepStyles.label} ${stepStyles.shimmer}`}>{label}</span>
        {turn.queuePosition === null && <ThinkClock className={styles.clock} />}
      </div>
    </motion.div>
  )
}
