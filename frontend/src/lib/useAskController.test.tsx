import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { RawSSEEvent } from './readSSE'

const streamAsk = vi.fn()
const resumeAsk = vi.fn()
const sendFeedback = vi.fn(async () => {})
// 必須列齊 controller 用到的每一個匯出：vi.mock 整包取代模組，漏掉的是 undefined，
// 而呼叫它拋的 TypeError 常被 fail-open 的 catch 吞掉 → 測試綠、功能死。
vi.mock('./askApi', () => ({
  streamAsk: (...a: unknown[]) => streamAsk(...a),
  resumeAsk: (...a: unknown[]) => resumeAsk(...a),
  getConversation: vi.fn(),
  getQaVersions: vi.fn(async () => []),
  stopAsk: vi.fn(async () => ({ qa_id: 'qa-stop' })),
  sendFeedback: (...a: unknown[]) => sendFeedback(...(a as [])),
}))
import { ApiError } from './api'
import { getConversation, stopAsk } from './askApi'
import { useAskController } from './useAskController'

afterEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
})

function withQueryClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { client, wrapper }
}

// 可控 async generator：每 yield 前等待外部 gate
function gated(events: RawSSEEvent[]) {
  const gates: Array<() => void> = []
  const gen = (async function* () {
    for (const ev of events) {
      await new Promise<void>(res => gates.push(res))
      yield ev
    }
  })()
  return { gen, release: () => gates.shift()?.() }
}

test('submit 串流：sources→token→done 寫入 state 並記 conversationId', async () => {
  const g = gated([
    { event: 'sources', data: [] },
    { event: 'token', data: 'Hi' },
    { event: 'done', data: { conversation_id: 'c1', qa_id: 'qa1' } },
  ])
  streamAsk.mockReturnValue(g.gen)
  const { wrapper } = withQueryClient()
  const { result } = renderHook(() => useAskController(), { wrapper })
  act(() => result.current.submit('Q'))
  expect(result.current.state.turns[0].phase).toBe('thinking')
  await act(async () => { g.release(); await Promise.resolve() })
  await act(async () => { g.release(); await Promise.resolve() })
  await act(async () => { g.release(); await Promise.resolve() })
  await waitFor(() => expect(result.current.state.turns[0].phase).toBe('done'))
  expect(result.current.state.turns[0].answer).toBe('Hi')
  expect(result.current.conversationId).toBe('c1')
})

test('latest-wins：第二次 submit 後，第一串流的後續事件被丟棄', async () => {
  const g1 = gated([{ event: 'token', data: 'A1' }, { event: 'token', data: 'A2' }])
  const g2 = gated([{ event: 'token', data: 'B1' }])
  streamAsk.mockReturnValueOnce(g1.gen).mockReturnValueOnce(g2.gen)
  const { wrapper } = withQueryClient()
  const { result } = renderHook(() => useAskController(), { wrapper })
  act(() => result.current.submit('Q1'))
  await act(async () => { g1.release(); await Promise.resolve() }) // A1 到第一輪
  act(() => result.current.submit('Q2'))                            // 遞增 reqId、abort 舊
  await act(async () => { g1.release(); await Promise.resolve() })  // A2 應被丟棄
  await act(async () => { g2.release(); await Promise.resolve() })  // B1 寫入新輪
  const turns = result.current.state.turns
  expect(turns).toHaveLength(2)
  expect(turns[0].answer).toBe('A1')  // 舊輪停在 A1，未被 A2 汙染
  expect(turns[1].answer).toBe('B1')
})

test('問答串流提早結束但未收到 done 時，turn 會標成 error', async () => {
  const g = gated([{ event: 'token', data: '半句回答' }])
  streamAsk.mockReturnValue(g.gen)
  const { wrapper } = withQueryClient()
  const { result } = renderHook(() => useAskController(), { wrapper })

  act(() => result.current.submit('Q'))
  await act(async () => { g.release(); await Promise.resolve() })

  await waitFor(() => expect(result.current.state.turns[0].phase).toBe('error'))
  expect(result.current.state.turns[0].answer).toBe('半句回答')
})

test('setFeedback：null 送到後端要變成 none（取消），state 同步清空', async () => {
  // null → 'none' 這層轉換只存在於 controller。後端刻意不收「可為 null 的欄位」，
  // 因為那讓「漏送欄位」與「明確取消」長得一樣；而轉換寫錯是靜默的（回饋失敗不打擾）。
  const g = gated([{ event: 'done', data: { conversation_id: 'c1', qa_id: 'qa1' } }])
  streamAsk.mockReturnValue(g.gen)
  const { wrapper } = withQueryClient()
  const { result } = renderHook(() => useAskController(), { wrapper })
  act(() => result.current.submit('Q'))
  await act(async () => { g.release(); await Promise.resolve() })
  await waitFor(() => expect(result.current.state.turns[0].phase).toBe('done'))
  const turnId = result.current.state.turns[0].id

  act(() => result.current.setFeedback(turnId, 'qa1', 'like'))
  expect(sendFeedback).toHaveBeenLastCalledWith('qa1', 'like')
  expect(result.current.state.turns[0].feedback).toBe('like')

  act(() => result.current.setFeedback(turnId, 'qa1', null))
  expect(sendFeedback).toHaveBeenLastCalledWith('qa1', 'none')
  expect(result.current.state.turns[0].feedback).toBeNull()
})

test('每次問答完成都會刷新 conversations 快取', async () => {
  const askGen1 = gated([{ event: 'done', data: { conversation_id: 'c1', qa_id: 'qa1' } }])
  const askGen2 = gated([{ event: 'done', data: { conversation_id: 'c1', qa_id: 'qa2' } }])
  streamAsk.mockReturnValueOnce(askGen1.gen).mockReturnValueOnce(askGen2.gen)

  const { client, wrapper } = withQueryClient()
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const { result } = renderHook(() => useAskController(), { wrapper })

  act(() => result.current.submit('Q1'))
  await act(async () => { askGen1.release(); await Promise.resolve() })
  await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1))

  act(() => result.current.submit('Q2'))
  await act(async () => { askGen2.release(); await Promise.resolve() })
  await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2))

  expect(invalidate).toHaveBeenNthCalledWith(1, { queryKey: ['conversations'] })
  expect(invalidate).toHaveBeenNthCalledWith(2, { queryKey: ['conversations'] })
})

test('載入對話 404（不存在或不是自己的）→ 改當新對話，下一題不帶那個 conversation_id', async () => {
  vi.mocked(getConversation).mockRejectedValueOnce(new ApiError(404, 'HTTP 404'))
  const g = gated([{ event: 'done', data: { conversation_id: 'c-new', qa_id: 'qa1' } }])
  streamAsk.mockReturnValueOnce(g.gen)
  const { wrapper } = withQueryClient()
  const { result } = renderHook(() => useAskController(), { wrapper })

  await act(async () => { await result.current.loadConversation('someone-elses') })
  expect(result.current.conversationId).toBeNull()

  act(() => result.current.submit('新題'))
  expect(streamAsk.mock.calls[0][0]).not.toHaveProperty('conversation_id')
  await act(async () => { g.release(); await Promise.resolve() })
})

test('載入對話的其他失敗（網路、500）維持現況', async () => {
  vi.mocked(getConversation).mockRejectedValueOnce(new ApiError(500, 'HTTP 500'))
  const { wrapper } = withQueryClient()
  const { result } = renderHook(() => useAskController(), { wrapper })
  await act(async () => { await result.current.loadConversation('c1') })
  expect(result.current.conversationId).toBe('c1')
})

// ── 新對話送出當下就進側欄「最近」（pendingConversation.ts）────────────────────────
// 暫存列（清單，新的在前）；測試一次只有一輪在開新對話，取第一筆。空清單＝null。
const pendingOf = (client: QueryClient) =>
  (client.getQueryData<{ key: string; title: string; conversationId: string | null }[]>(['pendingConversations']) ?? [])[0] ?? null

test('新對話：送出當下就記下暫存列（標題＝問題），done 之後清單重抓完就清掉', async () => {
  const g = gated([
    { event: 'token', data: 'Hi' },
    { event: 'done', data: { conversation_id: 'c1', qa_id: 'qa1' } },
  ])
  streamAsk.mockReturnValue(g.gen)
  const { client, wrapper } = withQueryClient()
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const { result } = renderHook(() => useAskController(), { wrapper })
  act(() => result.current.submit('半導體庫存何時見底'))
  expect(pendingOf(client)).toEqual({ key: result.current.state.turns[0].id, title: '半導體庫存何時見底', conversationId: null })
  await act(async () => { g.release(); await Promise.resolve() })
  expect(pendingOf(client)).not.toBeNull()  // 還在跑：暫存列留著
  await act(async () => { g.release(); await Promise.resolve() })
  await waitFor(() => expect(result.current.state.turns[0].phase).toBe('done'))
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['conversations'] })
  await waitFor(() => expect(pendingOf(client)).toBeNull())
})

// ── 回答沒跑完的新提問照樣落庫（/api/ask/stop），對話留在側欄「最近」────────────────────

test('新提問沒收到 done 就結束：補送停止請求落庫，這一串接到那一列、畫面仍是失敗', async () => {
  const g = gated([{ event: 'token', data: '半句' }])
  streamAsk.mockReturnValue(g.gen)
  const { client, wrapper } = withQueryClient()
  const { result } = renderHook(() => useAskController(), { wrapper })
  act(() => result.current.submit('Q'))
  const turnId = result.current.state.turns[0].id
  await act(async () => { g.release(); await Promise.resolve() })
  await waitFor(() => expect(result.current.state.turns[0].phase).toBe('error'))
  await waitFor(() => expect(stopAsk).toHaveBeenCalledTimes(1))
  expect(stopAsk).toHaveBeenCalledWith(expect.objectContaining({ question: 'Q', partial_answer: '半句', conversation_id: null }))
  // 接到停止列：續問與重生都留在同一串，重生帶 regenerate_of 不會多出一題
  await waitFor(() => expect(result.current.conversationId).toBe('qa-stop'))
  expect(result.current.state.turns[0].qaId).toBe('qa-stop')
  expect(result.current.state.turns[0].phase).toBe('error')
  await waitFor(() => expect(pendingOf(client)).toBeNull())  // 清單重抓完才清（重抓到的是真的那一列）
  void turnId
})

test('排隊已滿（429）的新提問同樣落庫', async () => {
  // eslint-disable-next-line require-yield -- 429 在串流開始前就拋（後端連 SSE 都沒開）
  streamAsk.mockImplementation(() => (async function* () {
    throw new ApiError(429, '問答排隊人數已滿，請稍後再試')
  })())
  const { wrapper } = withQueryClient()
  const { result } = renderHook(() => useAskController(), { wrapper })
  act(() => result.current.submit('Q'))
  await waitFor(() => expect(result.current.state.turns[0].errorText).toBe('問答排隊人數已滿，請稍後再試'))
  await waitFor(() => expect(stopAsk).toHaveBeenCalledTimes(1))
})

test('補存失敗：fail-open，畫面維持失敗、暫存列清掉', async () => {
  vi.mocked(stopAsk).mockRejectedValueOnce(new Error('stop failed: 503'))
  const g = gated([{ event: 'token', data: '半句' }])
  streamAsk.mockReturnValue(g.gen)
  const { client, wrapper } = withQueryClient()
  const { result } = renderHook(() => useAskController(), { wrapper })
  act(() => result.current.submit('Q'))
  await act(async () => { g.release(); await Promise.resolve() })
  await waitFor(() => expect(stopAsk).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(pendingOf(client)).toBeNull())
  expect(result.current.conversationId).toBeNull()
  expect(result.current.state.turns[0].qaId).toBeNull()
})

test('收到 done 的一輪不補存', async () => {
  const g = gated([{ event: 'done', data: { conversation_id: 'c1', qa_id: 'qa1' } }])
  streamAsk.mockReturnValue(g.gen)
  const { wrapper } = withQueryClient()
  const { result } = renderHook(() => useAskController(), { wrapper })
  act(() => result.current.submit('Q'))
  await act(async () => { g.release(); await Promise.resolve() })
  await waitFor(() => expect(result.current.state.turns[0].phase).toBe('done'))
  expect(stopAsk).not.toHaveBeenCalled()
})

test('重生失敗不補存：畫面退回舊版，補一個空的停止版會蓋掉它', async () => {
  const g1 = gated([{ event: 'token', data: '舊答案' }, { event: 'done', data: { conversation_id: 'c1', qa_id: 'qa1' } }])
  const g2 = gated([{ event: 'error', data: { detail: 'boom' } }])
  streamAsk.mockReturnValueOnce(g1.gen).mockReturnValueOnce(g2.gen)
  const { wrapper } = withQueryClient()
  const { result } = renderHook(() => useAskController(), { wrapper })
  act(() => result.current.submit('Q'))
  await act(async () => { g1.release(); await Promise.resolve() })
  await act(async () => { g1.release(); await Promise.resolve() })
  await waitFor(() => expect(result.current.state.turns[0].phase).toBe('done'))
  const turnId = result.current.state.turns[0].id
  act(() => result.current.regenerate(turnId, 'qa1', 'Q'))
  await act(async () => { g2.release(); await Promise.resolve() })
  await waitFor(() => expect(result.current.state.turns[0].phase).not.toBe('thinking'))
  expect(stopAsk).not.toHaveBeenCalled()
})

const savedUnfinished = () => JSON.parse(sessionStorage.getItem('tf.ask.unfinished') ?? 'null')

// 可控的串流：break() 模擬連線層失敗（重整時瀏覽器先中斷串流的 fetch）。
function breakable(first?: RawSSEEvent) {
  let breakStream!: () => void
  const gen = (async function* () {
    if (first) yield first
    await new Promise<void>((_, rej) => { breakStream = () => rej(new TypeError('Failed to fetch')) })
    yield { event: 'token', data: '不會到' } as RawSSEEvent
  })()
  return { gen, break: () => breakStream() }
}

test('重整或關頁（pagehide）時還沒跑完的那一輪：只留接回資訊，不送停止（後端照跑）', async () => {
  const g = gated([{ event: 'token', data: '半句' }, { event: 'token', data: '沒送到' }])
  streamAsk.mockReturnValue(g.gen)
  const { wrapper } = withQueryClient()
  const { result } = renderHook(() => useAskController(), { wrapper })
  act(() => result.current.submit('Q'))
  await act(async () => { g.release(); await Promise.resolve() })
  await waitFor(() => expect(result.current.state.turns[0].answer).toBe('半句'))
  window.dispatchEvent(new Event('pagehide'))
  expect(stopAsk).not.toHaveBeenCalled()
  const saved = savedUnfinished()
  expect(saved).toMatchObject({ resume: true, fresh: true, body: { question: 'Q', partial_answer: '半句', conversation_id: null } })
  expect(saved.body.request_id).toBe(streamAsk.mock.calls[0][0].request_id)
})

test('真實瀏覽器的重整順序：串流先被中斷、pagehide 才觸發——不送停止，接回資訊在中斷時就存好', async () => {
  vi.mocked(getConversation).mockResolvedValueOnce([])
  const s1 = breakable({ event: 'token', data: '前半' })
  streamAsk.mockReturnValue(s1.gen)
  const { result } = renderHook(() => useAskController(), { wrapper: withQueryClient().wrapper })
  await act(async () => { await result.current.loadConversation('c1') })
  act(() => result.current.submit('Q2'))
  await waitFor(() => expect(result.current.state.turns[0]?.answer).toBe('前半'))
  await act(async () => { s1.break(); await Promise.resolve() })
  await waitFor(() => expect(savedUnfinished()).not.toBeNull())
  window.dispatchEvent(new Event('pagehide'))
  expect(stopAsk).not.toHaveBeenCalled()
  expect(savedUnfinished()).toMatchObject({ resume: true, body: { question: 'Q2', conversation_id: 'c1', partial_answer: '前半' } })
})

const turnRow = (id: string, question: string, answer: string) => ({
  id, question, answer, created_at: null, feedback: null, sources: [], ext_sources: [], is_offtopic: false,
  notice_kind: null, thinking_ms: null, stages: [], followups: [], root_qa_id: null, version_count: 1, stopped: false,
})

/** 重整前：在 c1 追問 Q2，串流被中斷（重整），留下接回資訊。回傳那一輪的 request_id。 */
async function leaveUnfinishedFollowUp(): Promise<string> {
  vi.mocked(getConversation).mockResolvedValueOnce([turnRow('qa1', 'Q1', '第一題答案')])
  const s1 = breakable({ event: 'token', data: '前半' })
  streamAsk.mockReturnValueOnce(s1.gen)
  const before = renderHook(() => useAskController(), { wrapper: withQueryClient().wrapper })
  await act(async () => { await before.result.current.loadConversation('c1') })
  act(() => before.result.current.submit('Q2'))
  await waitFor(() => expect(before.result.current.state.turns[1]?.answer).toBe('前半'))
  await act(async () => { s1.break(); await Promise.resolve() })
  await waitFor(() => expect(savedUnfinished()).not.toBeNull())
  before.unmount()
  vi.mocked(getConversation).mockClear()
  return savedUnfinished().body.request_id
}

test('既有對話裡追問、等回答時重整：重整後接回同一次生成，那一題接在畫面上寫完，不送停止', async () => {
  const requestId = await leaveUnfinishedFollowUp()
  // 後端補送已產生的事件，再即時串流到 done。
  const g = gated([
    { event: 'token', data: '前半' },
    { event: 'token', data: '後半' },
    { event: 'done', data: { conversation_id: 'c1', qa_id: 'qa2' } },
  ])
  resumeAsk.mockResolvedValueOnce(g.gen)
  vi.mocked(getConversation).mockResolvedValueOnce([turnRow('qa1', 'Q1', '第一題答案')])
  const after = renderHook(() => useAskController(), { wrapper: withQueryClient().wrapper })
  await act(async () => { await after.result.current.loadConversation('c1') })
  expect(resumeAsk).toHaveBeenCalledWith(requestId, expect.any(AbortSignal))
  expect(getConversation).toHaveBeenCalledWith('c1')
  for (let i = 0; i < 3; i++) await act(async () => { g.release(); await Promise.resolve() })
  await waitFor(() => expect(after.result.current.state.turns[1]?.phase).toBe('done'))
  const turns = after.result.current.state.turns
  expect(turns).toHaveLength(2)
  expect(turns[1]).toMatchObject({ question: 'Q2', answer: '前半後半', qaId: 'qa2' })
  expect(stopAsk).not.toHaveBeenCalled()
  expect(savedUnfinished()).toBeNull()
})

test('接回時那一題重整前就已落庫（載入的對話裡已有）：不重複出現', async () => {
  await leaveUnfinishedFollowUp()
  resumeAsk.mockResolvedValueOnce((async function* () {
    yield { event: 'token', data: '完整答案' } as RawSSEEvent
    yield { event: 'done', data: { conversation_id: 'c1', qa_id: 'qa2' } } as RawSSEEvent
    yield { event: 'followups', data: ['下一題？'] } as RawSSEEvent
  })())
  vi.mocked(getConversation).mockResolvedValueOnce([turnRow('qa1', 'Q1', '第一題答案'), turnRow('qa2', 'Q2', '完整答案')])
  const after = renderHook(() => useAskController(), { wrapper: withQueryClient().wrapper })
  await act(async () => { await after.result.current.loadConversation('c1') })
  await waitFor(() => expect(after.result.current.state.turns[1]?.followups).toEqual(['下一題？']))
  expect(after.result.current.state.turns.map(t => t.id)).toEqual(['qa1', 'qa2'])
})

test('接不回（404：過期或 web 重啟過）：退回以留下的那一份送停止，落庫之後才載入對話', async () => {
  await leaveUnfinishedFollowUp()
  const kept = savedUnfinished().body
  resumeAsk.mockRejectedValueOnce(new ApiError(404, 'HTTP 404'))
  let landStop!: () => void
  vi.mocked(stopAsk).mockImplementationOnce(() => new Promise(res => { landStop = () => res({ qa_id: 'qa-stop' }) }))
  vi.mocked(getConversation).mockResolvedValueOnce([])
  const after = renderHook(() => useAskController(), { wrapper: withQueryClient().wrapper })
  let loading!: Promise<void>
  act(() => { loading = after.result.current.loadConversation('c1') })
  await waitFor(() => expect(stopAsk).toHaveBeenCalledTimes(1))
  expect(vi.mocked(stopAsk).mock.calls[0]).toEqual([kept])
  expect(getConversation).not.toHaveBeenCalled()
  await act(async () => { landStop(); await loading })
  expect(getConversation).toHaveBeenCalledWith('c1')
  // 只處理一次：再載入不會再送。
  vi.mocked(getConversation).mockResolvedValueOnce([])
  await act(async () => { await after.result.current.loadConversation('c2') })
  expect(stopAsk).toHaveBeenCalledTimes(1)
  expect(resumeAsk).toHaveBeenCalledTimes(1)
})

test('新對話的第一題重整：掛載時接回到空白畫面上，done 之後補上 conversationId（網址 ?c=）', async () => {
  const s1 = breakable({ event: 'token', data: '前半' })
  streamAsk.mockReturnValueOnce(s1.gen)
  const before = renderHook(() => useAskController(), { wrapper: withQueryClient().wrapper })
  act(() => before.result.current.submit('新題'))
  await waitFor(() => expect(before.result.current.state.turns[0]?.answer).toBe('前半'))
  await act(async () => { s1.break(); await Promise.resolve() })
  await waitFor(() => expect(savedUnfinished()).not.toBeNull())
  before.unmount()

  resumeAsk.mockResolvedValueOnce((async function* () {
    yield { event: 'token', data: '前半' } as RawSSEEvent
    yield { event: 'token', data: '後半' } as RawSSEEvent
    yield { event: 'done', data: { conversation_id: 'c-new', qa_id: 'qa-new' } } as RawSSEEvent
  })())
  const { client, wrapper } = withQueryClient()
  const after = renderHook(() => useAskController(), { wrapper })
  await waitFor(() => expect(after.result.current.conversationId).toBe('c-new'))
  expect(after.result.current.state.turns).toHaveLength(1)
  expect(after.result.current.state.turns[0]).toMatchObject({ question: '新題', answer: '前半後半', phase: 'done' })
  expect(getConversation).not.toHaveBeenCalled()
  expect(stopAsk).not.toHaveBeenCalled()
  await waitFor(() => expect(pendingOf(client)).toBeNull())
})

test('重生途中重整：接回時接在被重生的那一輪上', async () => {
  vi.mocked(getConversation).mockResolvedValueOnce([turnRow('qa1', 'Q1', '舊版')])
  const s1 = breakable({ event: 'token', data: '新' })
  streamAsk.mockReturnValueOnce(s1.gen)
  const before = renderHook(() => useAskController(), { wrapper: withQueryClient().wrapper })
  await act(async () => { await before.result.current.loadConversation('c1') })
  act(() => before.result.current.regenerate('qa1', 'qa1', 'Q1'))
  await waitFor(() => expect(before.result.current.state.turns[0]?.answer).toBe('新'))
  await act(async () => { s1.break(); await Promise.resolve() })
  await waitFor(() => expect(savedUnfinished()).toMatchObject({ resume: true, fresh: false, body: { regenerate_of: 'qa1' } }))
  before.unmount()

  resumeAsk.mockResolvedValueOnce((async function* () {
    yield { event: 'token', data: '新版答案' } as RawSSEEvent
    yield { event: 'done', data: { conversation_id: 'c1', qa_id: 'qa1b', root_qa_id: 'qa1', version_count: 2 } } as RawSSEEvent
  })())
  vi.mocked(getConversation).mockResolvedValueOnce([turnRow('qa1', 'Q1', '舊版')])
  const after = renderHook(() => useAskController(), { wrapper: withQueryClient().wrapper })
  await act(async () => { await after.result.current.loadConversation('c1') })
  await waitFor(() => expect(after.result.current.state.turns[0]?.phase).toBe('done'))
  const turn = after.result.current.state.turns[0]
  expect(after.result.current.state.turns).toHaveLength(1)
  expect(turn).toMatchObject({ answer: '新版答案', qaId: 'qa1b', versionCount: 2 })
  expect(turn.priorVersions[0]).toMatchObject({ answer: '舊版', qaId: 'qa1' })
})

test('接回途中按停止：照舊送停止（後端取消生成）', async () => {
  const requestId = await leaveUnfinishedFollowUp()
  resumeAsk.mockResolvedValueOnce((async function* () {
    yield { event: 'token', data: '前半' } as RawSSEEvent
    await new Promise<void>(() => {})
  })())
  vi.mocked(getConversation).mockResolvedValueOnce([turnRow('qa1', 'Q1', '第一題答案')])
  const after = renderHook(() => useAskController(), { wrapper: withQueryClient().wrapper })
  await act(async () => { await after.result.current.loadConversation('c1') })
  await waitFor(() => expect(after.result.current.state.turns[1]?.answer).toBe('前半'))
  await act(async () => { await after.result.current.stop() })
  expect(stopAsk).toHaveBeenCalledWith(expect.objectContaining({
    question: 'Q2', partial_answer: '前半', conversation_id: 'c1', request_id: requestId,
  }))
  expect(after.result.current.state.turns[1].phase).toBe('stopped')
})

test('串流中斷（連線層失敗）：不送停止，留下接回資訊', async () => {
  const s1 = breakable()
  streamAsk.mockReturnValue(s1.gen)
  const { result } = renderHook(() => useAskController(), { wrapper: withQueryClient().wrapper })
  act(() => result.current.submit('Q'))
  await act(async () => { s1.break(); await Promise.resolve() })
  await waitFor(() => expect(savedUnfinished()).toMatchObject({ resume: true, body: { question: 'Q' } }))
  expect(stopAsk).not.toHaveBeenCalled()
})

test('既有對話裡的續問不建暫存列', async () => {
  const g1 = gated([{ event: 'done', data: { conversation_id: 'c1', qa_id: 'qa1' } }])
  const g2 = gated([{ event: 'done', data: { conversation_id: 'c1', qa_id: 'qa2' } }])
  streamAsk.mockReturnValueOnce(g1.gen).mockReturnValueOnce(g2.gen)
  const { client, wrapper } = withQueryClient()
  const { result } = renderHook(() => useAskController(), { wrapper })
  act(() => result.current.submit('Q1'))
  await act(async () => { g1.release(); await Promise.resolve() })
  await waitFor(() => expect(pendingOf(client)).toBeNull())
  act(() => result.current.submit('Q2'))
  expect(pendingOf(client)).toBeNull()
})

test('新對話跑到一半被切走（開新對話）：不送停止，背景讀到 done 後側欄那一列接到真的那一串；畫面已是新對話', async () => {
  const g = gated([
    { event: 'token', data: 'A' },
    { event: 'token', data: 'B' },
    { event: 'done', data: { conversation_id: 'c-bg', qa_id: 'qa-bg' } },
  ])
  streamAsk.mockReturnValue(g.gen)
  const { client, wrapper } = withQueryClient()
  const resolved: unknown[] = []
  client.getQueryCache().subscribe(e => {
    if (e.query.queryKey[0] === 'pendingConversations') resolved.push(...(e.query.state.data as unknown[] ?? []))
  })
  const { result } = renderHook(() => useAskController(), { wrapper })
  act(() => result.current.submit('Q'))
  await act(async () => { g.release(); await Promise.resolve() })
  expect(pendingOf(client)).not.toBeNull()
  act(() => result.current.newConversation())
  // 連線沒被中斷：後端照跑，這條連線在背景讀到 done。暫存列留著，直到那時。
  expect((streamAsk.mock.calls[0][1] as AbortSignal).aborted).toBe(false)
  expect(pendingOf(client)).not.toBeNull()
  await act(async () => { g.release(); await Promise.resolve() })
  await act(async () => { g.release(); await Promise.resolve() })
  await waitFor(() => expect(resolved).toContainEqual(expect.objectContaining({ title: 'Q', conversationId: 'c-bg' })))
  await waitFor(() => expect(pendingOf(client)).toBeNull())
  expect(stopAsk).not.toHaveBeenCalled()
  expect(result.current.conversationId).toBeNull()
  expect(result.current.state.turns).toHaveLength(0)
})

test('被取代的那一輪在背景沒讀到 done 就斷了：暫存列照樣收掉，不會永遠 pending', async () => {
  const s1 = breakable({ event: 'token', data: 'A' })
  streamAsk.mockReturnValue(s1.gen)
  const { client, wrapper } = withQueryClient()
  const { result } = renderHook(() => useAskController(), { wrapper })
  act(() => result.current.submit('Q'))
  await waitFor(() => expect(result.current.state.turns[0]?.answer).toBe('A'))
  act(() => result.current.newConversation())
  await act(async () => { s1.break(); await Promise.resolve() })
  await waitFor(() => expect(pendingOf(client)).toBeNull())
  expect(stopAsk).not.toHaveBeenCalled()
})
