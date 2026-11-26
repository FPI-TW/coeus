import { useEffect, useRef, useState } from 'react'
import { MODE_DRAWS, resolvePreset, scaleRadii, type OrbState } from 'thinking-orbs'

// 大球尺寸：約可見高度的 25%，夾在 120～200px。套件的 <ThinkingOrb> 只收 20／32／64，
// 所以這裡直接用引擎在任意尺寸的 canvas 上畫，參數取 64 那組調校。
const MIN = 120
const MAX = 200
// 64 的點放大到 200px 會偏細，整體加粗一點。
const DOT_SCALE = 1.3
// 減少動態時停的那一幀：與套件 <ThinkingOrb> 的靜態畫面同一個時間點。
const STATIC_T = 0.6

function heroSize(): number {
  return Math.round(Math.min(MAX, Math.max(MIN, window.innerHeight * 0.25)))
}

function useHeroSize(): number {
  const [size, setSize] = useState(heroSize)
  useEffect(() => {
    const onResize = () => setSize(heroSize())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return size
}

function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * 思考中的大點陣球（thinking-orbs 的引擎）。canvas 照實際尺寸開、devicePixelRatio 上限 2，
 * 捲出畫面或分頁隱藏時停下；減少動態時只畫一張靜態畫面。純裝飾，步驟由下方文字念出。
 */
export function HeroOrb({ state }: { state: OrbState }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const size = useHeroSize()

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(size * dpr)
    canvas.height = Math.round(size * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { mode, speed, opts } = resolvePreset(state, 64)
    const draw = MODE_DRAWS[mode]
    const tuned = scaleRadii(opts, DOT_SCALE)
    const paint = (t: number) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, size, size)
      draw(ctx, size, t, false, tuned)
    }
    if (reducedMotion()) {
      paint(STATIC_T)
      return
    }

    let raf = 0
    let running = false
    let visible = true
    const loop = () => {
      paint((performance.now() / 1000) * speed)
      if (running) raf = requestAnimationFrame(loop)
    }
    const start = () => {
      if (running) return
      running = true
      raf = requestAnimationFrame(loop)
    }
    const stop = () => {
      running = false
      cancelAnimationFrame(raf)
    }
    paint((performance.now() / 1000) * speed)
    const io = typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting
        if (visible && document.visibilityState !== 'hidden') start()
        else stop()
      })
      : null
    io?.observe(canvas)
    const onVis = () => {
      if (document.visibilityState === 'hidden') stop()
      else if (visible) start()
    }
    document.addEventListener('visibilitychange', onVis)
    if (!io) start()
    return () => {
      stop()
      io?.disconnect()
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [state, size])

  return <canvas ref={ref} aria-hidden="true" data-orb-state={state} style={{ width: size, height: size, display: 'block' }} />
}
