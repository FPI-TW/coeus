import { stopAsk, type StopBody } from './askApi'

/**
 * 重整、關頁或串流中斷時還沒跑完的那一輪，在 sessionStorage 留一份給重整後的頁面。兩種：
 *
 * - **接回**（`resume: true`）：重整、串流被中斷。後端的生成不綁連線、照跑到完成（web/routers/ask.py），
 *   重整後的頁面先 `GET /api/ask/resume/{request_id}` 把那一題接回畫面上寫完（useAskController）。
 *   接不回（暫存過期、web 重啟過）才退回送停止：以這一份的部分答案存成「已停止」。
 * - **停止**（`resume: false`）：使用者按了停止、或串流已經結束卻沒收到 done，停止請求還沒送到。
 *   重整後先補送一次再載入對話：停止請求與重整後的 `GET /api/conversations/{id}` 各自在途，後者先到時
 *   載入的對話裡沒有那一輪；等補送回來再載入，對話裡就一定有它。停止請求由後端以 request_id 唯一索引
 *   收斂成同一列，補送不會多出一列。
 *
 * 實際瀏覽器裡重整時，串流的 fetch 會先被中斷、`pagehide` 才觸發：串流收尾那時就要把接回資訊存好，
 * `pagehide` 只補上它還在跑的情況。
 *
 * sessionStorage 是分頁層級，重整後還在、別的分頁看不到；存取失敗（隱私模式等）時接不回，
 * 那一題照樣在後端跑完、落庫，重新載入對話就看得到。
 */
const STORAGE_KEY = 'tf.ask.unfinished'
// 只處理剛留下的：重整幾秒內就會讀到。更舊的是 bfcache 還原或關頁後很久才回來，不該再冒出一題。
const MAX_AGE_MS = 5 * 60_000

export interface Unfinished {
  /** 停止請求的內容；接回時也從這裡取 request_id、question、conversation_id、regenerate_of／edit_of。 */
  body: StopBody
  resume: boolean
  /** 新提問（不是重生、不是編輯）：接不回時只有它要補送停止——重生與編輯的停止版會蓋掉畫面退回的舊版。 */
  fresh: boolean
}

interface Saved extends Unfinished { at: number }

export function saveUnfinished(body: StopBody, { resume = false, fresh = true }: { resume?: boolean; fresh?: boolean } = {}): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ body, resume, fresh, at: Date.now() } satisfies Saved))
  } catch { /* 存不了就接不回，見檔頭 */ }
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

function read(): Saved | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    const saved = JSON.parse(raw) as Saved
    if (saved?.body?.question && Date.now() - saved.at <= MAX_AGE_MS) return saved
    sessionStorage.removeItem(STORAGE_KEY)
    return null
  } catch { return null }
}

function take(pred: (saved: Saved) => boolean): Unfinished | null {
  const saved = read()
  if (!saved || !pred(saved)) return null
  try { sessionStorage.removeItem(STORAGE_KEY) } catch { /* 下次再讀到，最多多處理一次 */ }
  return { body: saved.body, resume: saved.resume === true, fresh: saved.fresh !== false }
}

/** 留下的那一份是不是「要接回的新對話第一題」（沒有 conversation_id 的頁面掛載時只有它要處理）。 */
export function peekUnfinished(): Unfinished | null {
  const saved = read()
  return saved ? { body: saved.body, resume: saved.resume === true, fresh: saved.fresh !== false } : null
}

/** 取走要接回的那一份。`conversationId` 給了就只取那一串的（undefined＝不限）。 */
export function takeResumable(conversationId?: string | null): Unfinished | null {
  return take(s => s.resume === true && (conversationId === undefined || (s.body.conversation_id ?? null) === conversationId))
}

/** 接不回時的退路：新提問以手上的部分答案送停止，存成「已停止」。送失敗也不拋（fail-open）。 */
export async function stopUnfinished(u: Unfinished): Promise<void> {
  if (!u.fresh) return
  await stopAsk(u.body).catch(() => { /* fail-open：照常載入，最多就是這一輪沒補到 */ })
}

let flushing: Promise<boolean> | null = null

/**
 * 有留下「停止」的那一份就補送，回傳是否送過（送失敗也算）。要接回的那一份不動（見 takeResumable）。
 * 每份只送一次；送的期間再呼叫（StrictMode 重跑 effect、頁面掛載與載入對話同時呼叫）共用同一個 promise。
 */
export function flushUnfinished(): Promise<boolean> {
  if (flushing) return flushing
  const saved = take(s => s.resume !== true)
  if (!saved) return Promise.resolve(false)
  // 停止的那一份一律補送（按停止的重生、編輯也是）；fresh 只決定「接不回時」要不要送。
  flushing = stopAsk(saved.body)
    .catch(() => { /* fail-open：照常載入，最多就是這一輪沒補到 */ })
    .then(() => true)
    .finally(() => { flushing = null })
  return flushing
}
