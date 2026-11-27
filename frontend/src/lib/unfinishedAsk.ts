import { stopAsk, type StopBody } from './askApi'

/**
 * 重整或關頁時還沒跑完的那一輪：在 sessionStorage 留一份停止請求，重整後的頁面先補送一次再載入對話。
 *
 * pagehide 的 keepalive 停止請求（useAskController）與重整後的 `GET /api/conversations/{id}` 是兩條
 * 各自在途的請求，誰先到後端不一定。後者先到時，載入的對話裡沒有那一輪：在既有對話裡追問、等回答時
 * 重整，剛送出的問題整題消失，要再重整一次才出現。停止請求由後端以 request_id 唯一索引收斂成同一列，
 * 補送不會多出一列；等它回來再載入，對話裡就一定有那一輪。
 *
 * 實際瀏覽器裡重整時，串流的 fetch 會先被中斷、`pagehide` 才觸發：串流收尾（useAskController 的 finish）
 * 已把這一輪當成「斷線」去落庫並清掉進行中的狀態，`pagehide` 那時已經找不到它；而收尾送出的停止請求又跟著
 * 頁面卸載被取消。所以收尾落庫（keepUnfinished）也先留一份在這裡，送成功才收掉（clearUnfinished）。
 *
 * sessionStorage 是分頁層級，重整後還在、別的分頁看不到；存取失敗（隱私模式等）就只剩 keepalive 那一次。
 */
const STORAGE_KEY = 'tf.ask.unfinished'
// 只補送剛留下的：重整幾秒內就會讀到。更舊的是 bfcache 還原或關頁後很久才回來，不該再冒出一題。
const MAX_AGE_MS = 5 * 60_000

interface Saved { body: StopBody; at: number }

export function saveUnfinished(body: StopBody): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ body, at: Date.now() } satisfies Saved))
  } catch { /* 存不了就只剩 keepalive 那一次 */ }
}

/**
 * 落庫成功（或後端明確拒絕）之後收掉留下的那一份。只收同一個 request_id 的：期間若又留了別輪的，不能誤刪。
 */
export function clearUnfinished(requestId: string | undefined): void {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (raw === null) return
    const saved = JSON.parse(raw) as Saved
    if (saved?.body?.request_id === requestId) sessionStorage.removeItem(STORAGE_KEY)
  } catch { /* 收不掉最多重整後多補送一次，後端以 request_id 收斂成同一列 */ }
}

function takeUnfinished(): Saved | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    sessionStorage.removeItem(STORAGE_KEY)
    const saved = JSON.parse(raw) as Saved
    return saved?.body?.question && Date.now() - saved.at <= MAX_AGE_MS ? saved : null
  } catch { return null }
}

let flushing: Promise<boolean> | null = null

/**
 * 有留下的那一輪就補送停止，回傳是否送過（送失敗也算：後端可能已收到 keepalive 那一次）。
 * 每份只送一次；送的期間再呼叫（StrictMode 重跑 effect、頁面掛載與載入對話同時呼叫）共用同一個 promise。
 */
export function flushUnfinished(): Promise<boolean> {
  if (flushing) return flushing
  const saved = takeUnfinished()
  if (!saved) return Promise.resolve(false)
  flushing = stopAsk(saved.body)
    .catch(() => { /* fail-open：照常載入，最多就是這一輪沒補到 */ })
    .then(() => true)
    .finally(() => { flushing = null })
  return flushing
}
