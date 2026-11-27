import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { askReducer, initialAskState, turnFromHistory, type AskAction, type AskState } from './askReducer'
import { parseAskEvent } from './askSchemas'
import { streamAsk, resumeAsk, getConversation, sendFeedback, stopAsk, getQaVersions, type StopBody } from './askApi'
import { ApiError } from './api'
import type { RawSSEEvent } from './readSSE'
import { clearPendingConversation, resolvePendingConversation, startPendingConversation } from './pendingConversation'
import {
  clearUnfinished, flushUnfinished, peekUnfinished, saveUnfinished, stopUnfinished, takeResumable, type Unfinished,
} from './unfinishedAsk'
import { useLocale } from './useLocale'
import { useWebSearch, useWebSearchPaused } from './useWebSearch'

let seq = 0
const newId = () => `t${Date.now()}_${seq++}`

interface StreamMeta { regenerateOf?: string; editOf?: string; fresh: boolean }

/**
 * 一條串流連線。`detached`＝畫面已換到別處（開新對話、切對話、又送出別題），但這一題還沒跑完：
 * 後端的生成不綁連線、照跑到完成（只有按停止會中止），這條連線就在背景讀到 done 為止，
 * 側欄的暫存列與清單等那時再收，期間不再動畫面。
 */
interface StreamHandle { ctrl: AbortController; detached: boolean }

/** 新提問（submit，不是重生、不是編輯）：沒跑完也要落庫的那一種，理由見 abortAsk。 */
function isFreshStream(meta: StreamMeta | null): boolean {
  return meta?.fresh === true
}
const newRequestId = () => globalThis.crypto?.randomUUID?.()
  ?? `00000000-0000-4000-8000-${`${Date.now().toString(16)}${seq++}`.padStart(12, '0').slice(-12)}`

export interface UseAskController {
  state: AskState
  conversationId: string | null
  submit: (question: string) => void
  stop: () => Promise<void>
  regenerate: (turnId: string, qaId: string | null, question: string) => void
  editResubmit: (turnId: string, qaId: string | null, newQuestion: string) => void
  setVersion: (turnId: string, index: number) => void
  loadVersions: (turnId: string, rootId: string) => Promise<boolean>
  loadConversation: (id: string) => Promise<void>
  newConversation: () => void
  /** value null ＝取消評價（再點一次已亮起的那顆）；送到後端會轉成 'none'。 */
  setFeedback: (turnId: string, qaId: string, value: 'like' | 'dislike' | null) => void
}

export function useAskController(): UseAskController {
  const [state, reactDispatch] = useReducer(askReducer, initialAskState)
  // stateRef 在 dispatch 當下就同步推進（reducer 是純函式，與 React 算出的 state 一致）。原本靠 effect
  // 在重繪後才同步：串流最後幾個 token 剛 dispatch 就收尾時，停止／補存送出的半成品會少掉那幾個字。
  const stateRef = useRef<AskState>(initialAskState)
  const dispatch = useCallback((action: AskAction) => {
    stateRef.current = askReducer(stateRef.current, action)
    reactDispatch(action)
  }, [])
  const [conversationId, setConversationId] = useState<string | null>(null)
  const locale = useLocale()  // M10b：輸出語言，注入 /api/ask 請求
  // M11：搜尋網路開關。與 locale 同樣在送出當下取值——切換不影響已在跑的那一輪。
  // 網搜暫停期間一律送 false（理由見 useWebSearchPaused：旗標 ask.web_search 沒開）；hook 照呼叫。
  const paused = useWebSearchPaused()
  const web = useWebSearch() && !paused
  const qc = useQueryClient()
  const convRef = useRef<string | null>(null)
  const reqId = useRef(0)
  const askCtrl = useRef<AbortController | null>(null)
  const streamHandleRef = useRef<StreamHandle | null>(null)
  const streamTurnRef = useRef<string | null>(null)
  const streamRequestIdRef = useRef<string | null>(null)
  // 進行中串流的請求體中繼資料。stop() 要據此把 regenerate_of / edit_of 轉送給
  // /api/ask/stop——重生的停止列才接得回版本鏈、編輯的停止列才會觸發後端截斷。
  // 從 state 反推（舊作法：翻 priorVersions）在編輯路徑上根本無值可推，故直接記。
  const streamBodyRef = useRef<StreamMeta | null>(null)
  // 進行中的串流是否已收到 done（之後還有追問建議要收）：收到了就已經落庫，不必再補存。
  const streamDoneRef = useRef(false)
  const versionRequestId = useRef(0)

  // 新對話在側欄的暫存列（見 pendingConversation.ts）。拿到 conversation_id 就先改連過去，
  // 等清單重抓完（真的那一列已在清單裡）才清掉，中間不會有一拍空掉。沒拿到就直接清，
  // 仍重抓一次：後端有沒有留下停止或失敗的列，以清單為準。
  const settlePending = useCallback((turnId: string, conversationId: string | null) => {
    if (conversationId) resolvePendingConversation(qc, turnId, conversationId)
    else clearPendingConversation(qc, turnId, { unresolvedOnly: true })
    void qc.invalidateQueries({ queryKey: ['conversations'] }).then(() => clearPendingConversation(qc, turnId))
  }, [qc])

  // 送 /api/ask/stop 的內容：畫面上那一輪的現況。要在清掉 stream*Ref 之前取。
  const unfinishedBody = useCallback((turnId: string): StopBody => {
    const t = stateRef.current.turns.find(x => x.id === turnId)
    const requestId = streamRequestIdRef.current
    const streamBody = streamBodyRef.current
    // 重生／編輯途中被停止：regenerate_of 讓停止列接回版本鏈，edit_of 讓後端
    // 執行與畫面一致的截斷。兩者都直接取自進行中串流的請求體（streamBodyRef），
    // 不再從 priorVersions 反推——編輯路徑上 priorVersions 已被清空、推不出來。
    return {
      question: t?.question ?? '',
      conversation_id: convRef.current,
      partial_answer: t?.answer ?? '',
      sources: t?.sources ?? [],
      ext_sources: t?.extSources ?? [],
      stages: t?.stages ?? [],
      ...(requestId ? { request_id: requestId } : {}),
      ...(streamBody?.regenerateOf ? { regenerate_of: streamBody.regenerateOf } : {}),
      ...(streamBody?.editOf ? { edit_of: streamBody.editOf } : {}),
    }
  }, [])

  // 沒跑完的那一輪落庫（/api/ask/stop），對話才會留在側欄「最近」、重整後還在。同一個 request_id
  // 的完成與停止由後端唯一索引收斂成同一列，後端自己已記下的失敗輪不會多出一列。
  // `my` 是這一輪的世代：回應在途期間使用者已重生／送出新題／切換對話（都會 ++reqId），
  // convRef、URL 同步、qaId 這些畫面上的副作用套上去就是把新狀態汙染回舊對話——只做落庫與側欄。
  const keepUnfinished = useCallback(async (turnId: string, body: StopBody, my: number) => {
    let qaId: string | null = null
    // 先留一份給重整後的頁面：送出之後馬上重整，這次請求會跟著頁面卸載被取消（見 unfinishedAsk.ts）。
    saveUnfinished(body)
    try {
      qaId = (await stopAsk(body)).qa_id
      clearUnfinished(body.request_id)
      if (my === reqId.current) {
        // 首題尚未收到 done 時，資料庫以 COALESCE(conversation_id, id) 將停止列
        // 視為自己的對話。沿用 qa_id，才能讓後續重生／續問留在同一串。
        if (!convRef.current) {
          convRef.current = qaId
          setConversationId(qaId)
        }
        dispatch({ type: 'set-qa', id: turnId, qaId })
      }
    } catch (e) {
      // 後端明確拒絕（非 2xx）就不必留著重送；連線層失敗（含頁面卸載取消）留著，重整後補送。
      if (e instanceof Error && e.message.startsWith('stop failed')) clearUnfinished(body.request_id)
      /* fail-open：畫面維持原狀，僅這一輪沒存到 */
    } finally {
      // 開新對話的那一輪：qa_id 就是這一串的 id。不是時 key 對不上，只剩重抓清單。
      settlePending(turnId, body.conversation_id ? null : qaId)
    }
  }, [settlePending, dispatch])

  // 被取代的串流（開新對話、換到別的對話、又送出別題）：還沒跑完就不中斷也不送停止——只有按停止才中止生成。
  // 連線改在背景讀到 done（見 StreamHandle），那一題照常落庫成完整回答。已收到 done 的直接斷開。
  const abortAsk = useCallback(() => {
    const supersededTurn = streamTurnRef.current
    if (askCtrl.current) {
      const handle = streamHandleRef.current
      if (handle && supersededTurn && !streamDoneRef.current && streamRequestIdRef.current) handle.detached = true
      else askCtrl.current.abort()
      askCtrl.current = null
      streamHandleRef.current = null
      streamTurnRef.current = null
      streamRequestIdRef.current = null
      streamBodyRef.current = null
      // 取代中的串流不會再通過 reqId 檢查而觸發 ask-end；先結束它，避免 UI 永久 busy。
      if (supersededTurn) dispatch({ type: 'ask-end', id: supersededTurn })
    }
  }, [dispatch])

  // 重整或關頁：後端照跑，留下接回資訊給重整後的頁面（見 unfinishedAsk.ts）。不送停止。
  // 實際瀏覽器多半是串流先被中斷（收尾那時已存好）、這裡才觸發，這裡只補上串流還連著的情況。
  useEffect(() => {
    const onPageHide = () => {
      const turnId = streamTurnRef.current
      if (!turnId || !askCtrl.current || streamDoneRef.current || !streamRequestIdRef.current) return
      saveUnfinished(unfinishedBody(turnId), { resume: true, fresh: isFreshStream(streamBodyRef.current) })
    }
    window.addEventListener('pagehide', onPageHide)
    return () => window.removeEventListener('pagehide', onPageHide)
  }, [unfinishedBody])

  // 讀一條串流（新提問、重生、編輯、重整後接回都走這裡），事件寫到 turnId 那一輪。
  // loadedIds：接回時載入的對話裡已有的列。done 的 qa_id 已在其中＝重整前就已落庫，載入的那一列就是它，
  // 拿掉接回的這一輪（之後的追問建議改給那一列），同一題不出現兩次。
  const consume = useCallback(async (opts: {
    turnId: string; my: number; handle: StreamHandle; creating: boolean
    events: AsyncIterable<RawSSEEvent>
    loadedIds?: Set<string>
  }) => {
    const { my, handle, creating, loadedIds } = opts
    let target = opts.turnId
    let done = false
    // 背景讀完的串流（被取代的那一題）：只收側欄。
    const settleDetached = (conversationId: string | null) => {
      if (creating) settlePending(opts.turnId, conversationId)
      else void qc.invalidateQueries({ queryKey: ['conversations'] })
    }
    // 收尾（仍是目前這一輪時）。內容要在清掉 stream*Ref 之前取；回傳的是畫面標好結束狀態之後才做的事。
    // - interrupted（連線層失敗，含重整時串流先被中斷）：後端照跑，只留接回資訊。
    // - 其餘沒收到 done 就結束的新提問（失敗、排隊已滿）：照樣落庫（/api/ask/stop），對話才留在側欄「最近」。
    //   重生與編輯不補存：它們取代的是已有的答案，失敗時畫面退回舊版，補存一個空的停止版反而蓋掉它。
    const finish = (interrupted: boolean) => {
      const meta = streamBodyRef.current
      const body = done ? null : unfinishedBody(target)
      streamTurnRef.current = null; streamRequestIdRef.current = null; streamBodyRef.current = null
      streamHandleRef.current = null
      return () => {
        if (body && interrupted && body.request_id) {
          saveUnfinished(body, { resume: true, fresh: isFreshStream(meta) })
          if (creating) settlePending(target, null)
        } else if (body && isFreshStream(meta)) void keepUnfinished(target, body, my)
        else if (creating && !done) settlePending(target, null)
      }
    }
    try {
      for await (const raw of opts.events) {
        const ev = parseAskEvent(raw)
        if (my !== reqId.current) {
          if (!handle.detached) return
          if (ev?.event === 'done') {
            done = true
            settleDetached(ev.data.conversation_id)
            handle.ctrl.abort()
            return
          }
          continue
        }
        if (!ev) continue
        if (ev.event === 'done') {
          done = true
          streamDoneRef.current = true
          if (!convRef.current) {
            convRef.current = ev.data.conversation_id
            setConversationId(ev.data.conversation_id)
          }
          if (creating) settlePending(target, ev.data.conversation_id)
          else void qc.invalidateQueries({ queryKey: ['conversations'] })
          const qaId = ev.data.qa_id
          if (qaId && qaId !== target && loadedIds?.has(qaId)) {
            dispatch({ type: 'remove', id: target })
            target = qaId
            streamTurnRef.current = qaId
            continue
          }
        }
        if (ev.event === 'followups') dispatch({ type: 'followups', id: target, data: ev.data })
        else dispatch({ type: 'ask-event', id: target, event: ev })
      }
      if (my === reqId.current) {
        const after = finish(false)
        dispatch({ type: 'ask-end', id: target })
        after()
      } else if (handle.detached && !done) settleDetached(null)
    } catch (err) {
      if (my === reqId.current) {
        const after = finish(!(err instanceof ApiError))
        // 429＝排隊已滿，後端連 SSE 都沒開。這時 'ask-end' 的「查詢逾時或失敗」是
        // 錯的診斷，會讓人一直重按；改用後端給的原因，使用者才知道要等一下。
        if (err instanceof ApiError && err.status === 429) {
          dispatch({ type: 'ask-event', id: target, event: { event: 'error', data: { detail: err.message } } })
        } else {
          dispatch({ type: 'ask-end', id: target })
        }
        after()
      } else if (handle.detached && !done) settleDetached(null)
    }
  }, [settlePending, unfinishedBody, keepUnfinished, qc, dispatch])

  const begin = useCallback((turnId: string, handle: StreamHandle, requestId: string, meta: StreamMeta) => {
    askCtrl.current = handle.ctrl
    streamHandleRef.current = handle
    streamTurnRef.current = turnId
    streamRequestIdRef.current = requestId
    streamBodyRef.current = meta
    streamDoneRef.current = false
  }, [])

  // 接回重整前沒跑完的那一輪（unfinishedAsk.ts）。convId＝要載入的對話；null＝新對話的第一題（畫面是空的）。
  // 接不回（404：過期、web 重啟過）就退回以留下的部分答案送停止，回傳 false，由呼叫端照常載入對話。
  // 回傳 true＝已處理（含已載入對話）。載入對話失敗照樣拋給呼叫端。
  const resumeUnfinished = useCallback(async (u: Unfinished, convId: string | null, my: number): Promise<boolean> => {
    const requestId = u.body.request_id
    if (!requestId) { await stopUnfinished(u); return false }
    const handle: StreamHandle = { ctrl: new AbortController(), detached: false }
    let events: AsyncIterable<RawSSEEvent>
    try {
      events = await resumeAsk(requestId, handle.ctrl.signal)
    } catch {
      await stopUnfinished(u)
      return false
    }
    // 期間使用者已換到別處：這一題在後端照跑完，不必接到畫面上。
    if (my !== reqId.current) { handle.ctrl.abort(); return true }
    let loadedIds: Set<string> | undefined
    if (convId) {
      try {
        const items = await getConversation(convId)
        if (my !== reqId.current) { handle.ctrl.abort(); return true }
        dispatch({ type: 'load', turns: items.map(turnFromHistory) })
        loadedIds = new Set(items.map(item => item.id))
      } catch (err) {
        handle.ctrl.abort()
        throw err
      }
    }
    const meta: StreamMeta = { regenerateOf: u.body.regenerate_of, editOf: u.body.edit_of, fresh: u.fresh }
    const question = u.body.question
    let turnId: string
    const ref = meta.regenerateOf ?? meta.editOf
    if (ref) {
      // 重生／編輯的那一輪：還沒跑完時對話裡是舊版，接在它上面。找不到＝已經跑完（舊版已停用），載入的就是新版。
      const turn = stateRef.current.turns.find(item => item.qaId === ref || item.id === ref || item.rootQaId === ref)
      if (!turn) { handle.ctrl.abort(); return true }
      turnId = turn.id
      if (meta.regenerateOf) dispatch({ type: 'regenerate-start', id: turnId })
      else {
        dispatch({ type: 'truncate-after', id: turnId })
        dispatch({ type: 'submit-edit', id: turnId, question })
      }
    } else {
      turnId = newId()
      dispatch({ type: 'submit', id: turnId, question, startedAt: Date.now() })
    }
    begin(turnId, handle, requestId, meta)
    const creating = !convId
    if (creating) startPendingConversation(qc, turnId, question)
    void consume({ turnId, my, handle, creating, events, loadedIds })
    return true
  }, [begin, consume, qc, dispatch])

  // 要接回的那一份不是這一串的（重整後沒回到那一串）：還接得回就不管它（後端照跑完），接不回才補送停止。
  const settleElsewhere = useCallback(async (u: Unfinished) => {
    const ctrl = new AbortController()
    try {
      if (!u.body.request_id) throw new Error('no request_id')
      await resumeAsk(u.body.request_id, ctrl.signal)
      ctrl.abort()
    } catch {
      await stopUnfinished(u)
      void qc.invalidateQueries({ queryKey: ['conversations'] })
    }
  }, [qc])

  // 重整前留下的那一輪。沒帶 ?c 的頁面（新對話的第一題）不會走 loadConversation，只有這裡會處理：
  // 要接回的就接到空白畫面上；要停止的補送之後側欄重抓一次。帶 ?c 的由 loadConversation 處理。
  useEffect(() => {
    const u = peekUnfinished()
    if (u?.resume && !u.body.conversation_id) {
      const taken = takeResumable(null)
      if (!taken) return
      const my = ++reqId.current
      void resumeUnfinished(taken, null, my).then(
        ok => { if (!ok) void qc.invalidateQueries({ queryKey: ['conversations'] }) },
        () => { /* 沒有要載入的對話，不會走到這裡 */ },
      )
      return
    }
    void flushUnfinished().then(flushed => {
      if (flushed) void qc.invalidateQueries({ queryKey: ['conversations'] })
    })
  }, [qc, resumeUnfinished])


  // 共用串流：submit/regenerate/editResubmit 皆走此；fresh＝submit 的新提問。
  const runStream = useCallback((turnId: string, body: { question: string; conversation_id?: string; regenerate_of?: string; edit_of?: string }, fresh = false) => {
    abortAsk()
    const my = ++reqId.current
    const handle: StreamHandle = { ctrl: new AbortController(), detached: false }
    const requestId = newRequestId()
    begin(turnId, handle, requestId, { regenerateOf: body.regenerate_of, editOf: body.edit_of, fresh })
    // 沒帶 conversation_id＝這一輪會開出新的一串：送出當下就讓它出現在側欄「最近」，不等跑完。
    const creating = !body.conversation_id
    if (creating) startPendingConversation(qc, turnId, body.question)
    void consume({
      turnId, my, handle, creating,
      events: streamAsk({ ...body, request_id: requestId, locale, web }, handle.ctrl.signal),
    })
  }, [abortAsk, begin, consume, qc, locale, web])

  const submit = useCallback((question: string) => {
    const q = question.trim()
    if (!q) return
    const id = newId()
    dispatch({ type: 'submit', id, question: q, startedAt: Date.now() })
    const body = convRef.current ? { question: q, conversation_id: convRef.current } : { question: q }
    runStream(id, body, true)
  }, [runStream, dispatch])

  const stop = useCallback(async () => {
    const turnId = streamTurnRef.current
    const body = turnId ? unfinishedBody(turnId) : null
    const my = ++reqId.current
    askCtrl.current?.abort(); askCtrl.current = null
    streamHandleRef.current = null
    streamTurnRef.current = null
    streamRequestIdRef.current = null
    streamBodyRef.current = null
    if (!turnId || !body) return
    const t = stateRef.current.turns.find(x => x.id === turnId)
    // 先落地 stopped，再等 /api/ask/stop 的回應補 qaId：token 已停，畫面不能
    // 繼續掛在「生成中」等一個沒有逾時保證的網路往返——期間停止鈕看起來像壞掉。
    dispatch({ type: 'ask-stop', id: turnId, qaId: t?.qaId ?? null })
    await keepUnfinished(turnId, body, my)
  }, [unfinishedBody, keepUnfinished, dispatch])

  const regenerate = useCallback((turnId: string, qaId: string | null, question: string) => {
    dispatch({ type: 'regenerate-start', id: turnId })
    const body: { question: string; conversation_id?: string; regenerate_of?: string } = { question }
    if (convRef.current) body.conversation_id = convRef.current
    if (qaId) body.regenerate_of = qaId
    runStream(turnId, body)
  }, [runStream, dispatch])

  const editResubmit = useCallback((turnId: string, qaId: string | null, newQuestion: string) => {
    const q = newQuestion.trim()
    if (!q) return
    dispatch({ type: 'truncate-after', id: turnId })
    dispatch({ type: 'submit-edit', id: turnId, question: q })
    const body: { question: string; conversation_id?: string; edit_of?: string } = { question: q }
    if (convRef.current) body.conversation_id = convRef.current
    if (qaId) body.edit_of = qaId
    runStream(turnId, body)
  }, [runStream, dispatch])

  const setVersion = useCallback((turnId: string, index: number) => dispatch({ type: 'set-version', id: turnId, index }), [dispatch])

  const loadVersions = useCallback(async (turnId: string, rootId: string) => {
    const requestId = ++versionRequestId.current
    try {
      const versions = await getQaVersions(rootId)
      const turn = stateRef.current.turns.find(item => item.id === turnId)
      // 避免晚到的舊請求覆蓋目前已切換到其他題目的版本資料；空結果也不應把
      // 已知的 versionCount 歸零，否則 pager 會顯示 1/0。
      if (requestId !== versionRequestId.current || !turn || turn.rootQaId !== rootId || versions.length === 0) return false
      dispatch({ type: 'load-versions', id: turnId, versions })
      return true
    } catch { return false }
  }, [dispatch])

  const loadConversation = useCallback(async (id: string) => {
    abortAsk()
    const my = ++reqId.current
    convRef.current = id
    setConversationId(id)
    try {
      // 重整前按了停止、還沒送到的那一輪先落庫再載入，否則載入的對話裡可能還沒有它（見 unfinishedAsk.ts）。
      await flushUnfinished()
      if (my !== reqId.current) return
      // 重整前沒跑完的那一輪：是這一串的就接回畫面上寫完（接不回才送停止、照常載入）；別串的另外收。
      const u = takeResumable()
      if (u && (u.body.conversation_id ?? null) === id) {
        if (await resumeUnfinished(u, id, my)) return
        if (my !== reqId.current) return
      } else if (u) void settleElsewhere(u)
      const items = await getConversation(id)
      if (my !== reqId.current) return
      dispatch({ type: 'load', turns: items.map(turnFromHistory) })
    } catch (err) {
      // 404＝這串不存在或不是你的（後端兩者回同一個 404，看不出差別）。若還掛著這個
      // conversation_id，下一題送出時 /api/ask 也會回 404、畫面卡死——改當新對話。
      if (my === reqId.current && err instanceof ApiError && err.status === 404) {
        convRef.current = null
        setConversationId(null)
        dispatch({ type: 'reset' })
      }
      /* 其他失敗不破壞現況 */
    }
  }, [abortAsk, resumeUnfinished, settleElsewhere, dispatch])

  const newConversation = useCallback(() => {
    abortAsk()
    ++reqId.current
    convRef.current = null
    setConversationId(null)
    dispatch({ type: 'reset' })
  }, [abortAsk, dispatch])

  const setFeedback = useCallback((turnId: string, qaId: string, value: 'like' | 'dislike' | null) => {
    dispatch({ type: 'feedback', id: turnId, value })
    void sendFeedback(qaId, value ?? 'none').catch(() => { /* 回饋失敗不打擾 */ })
  }, [dispatch])

  return {
    state, conversationId, submit, stop, regenerate, editResubmit, setVersion, loadVersions,
    loadConversation, newConversation, setFeedback,
  }
}
