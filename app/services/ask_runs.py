"""進行中的問答生成（`/api/ask` 帶 `request_id` 時）：生成與 HTTP 連線解耦，重整後可接回。

一次提問＝一個 `AskRun`：背景 task 把 SSE 事件框逐一 `append` 進來，HTTP 回應（`/api/ask` 本身、
`/api/ask/resume/{request_id}`）都只是訂閱者——先補送已暫存的事件、再即時收新的，直到 run 結束。
訂閱者斷線只是退訂，不影響 task；只有 `cancel`（`/api/ask/stop`）會中止生成。

**純行程內記憶體**：web 是單一行程（`web/concurrency.py` 的啟動守門），web 重啟後全部消失，接回端回 404，
前端退回「以手上的部分答案送 `/api/ask/stop`」的路徑。

保留與上限：
- 結束後保留 `ttl` 秒供接回，之後在下一次存取時清掉（惰性清除，沒有計時器）。進行中的 run 不清。
- 單一 run 暫存的事件數與位元組有上限（`max_events`／`max_bytes`）。超過時**停止暫存新事件**、標記
  `overflowed`，但生成照跑、已連上的訂閱者照常即時收到（推送走各自的佇列，不經暫存區）；之後的接回一律
  視為接不回（`resumable` 回 None → 404），因為補送不出完整內容。
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncGenerator, Awaitable, Callable

logger = logging.getLogger(__name__)

# 一般回答是數百到數千個 token 事件（每個數十位元組）加一個數 KB～數十 KB 的 sources。
# 上限抓在正常回答的十倍以上，只防失控的 run 吃光記憶體。
DEFAULT_MAX_EVENTS = 20_000
DEFAULT_MAX_BYTES = 2 * 1024 * 1024

_END = object()  # 訂閱佇列的結束記號


class AskRun:
    """一次提問的事件暫存與訂閱者。只在事件迴圈執行緒上操作，不需要鎖。"""

    def __init__(self, request_id: str, user_id: str | None, *, max_events: int, max_bytes: int):
        self.request_id = request_id
        self.user_id = user_id
        self.events: list[str] = []
        self.finished = False
        self.finished_at: float | None = None
        self.overflowed = False
        self.task: asyncio.Task | None = None
        self._bytes = 0
        self._max_events = max_events
        self._max_bytes = max_bytes
        self._subscribers: set[asyncio.Queue] = set()

    def append(self, frame: str) -> None:
        if self.finished:
            return
        for q in self._subscribers:
            q.put_nowait(frame)
        if self.overflowed:
            return
        size = len(frame.encode("utf-8"))
        if len(self.events) >= self._max_events or self._bytes + size > self._max_bytes:
            self.overflowed = True
            logger.warning(
                "問答 run %s 暫存超過上限（%d 事件／%d 位元組），之後接不回；生成照跑",
                self.request_id, len(self.events), self._bytes,
            )
            return
        self.events.append(frame)
        self._bytes += size

    def finish(self, now: float) -> None:
        if self.finished:
            return
        self.finished = True
        self.finished_at = now
        for q in self._subscribers:
            q.put_nowait(_END)

    def subscribe(self) -> AsyncGenerator[str, None]:
        """先補送暫存的全部事件、再即時串流到結束。

        訂閱在**呼叫當下**就登記（快照與登記之間沒有 await，不會漏掉事件），不是在第一次迭代時；
        迭代端斷線（產生器被 aclose／取消）時退訂。
        """
        backlog = list(self.events)
        queue: asyncio.Queue | None = None
        if not self.finished:
            queue = asyncio.Queue()
            self._subscribers.add(queue)
        return self._stream(backlog, queue)

    async def _stream(self, backlog: list[str], queue: asyncio.Queue | None) -> AsyncGenerator[str, None]:
        try:
            for frame in backlog:
                yield frame
            if queue is None:
                return
            while True:
                item = await queue.get()
                if item is _END:
                    return
                yield item
        finally:
            if queue is not None:
                self._subscribers.discard(queue)


class AskRunRegistry:
    """以 `request_id` 為鍵的 run 登錄表。查詢一律帶 user_id：不是本人的 run 與不存在的看起來一樣。"""

    def __init__(
        self,
        *,
        ttl: float,
        max_events: int = DEFAULT_MAX_EVENTS,
        max_bytes: int = DEFAULT_MAX_BYTES,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.ttl = ttl
        self.max_events = max_events
        self.max_bytes = max_bytes
        self._clock = clock
        self._runs: dict[str, AskRun] = {}

    def _purge(self) -> None:
        now = self._clock()
        expired = [
            rid for rid, run in self._runs.items()
            if run.finished and run.finished_at is not None and now - run.finished_at >= self.ttl
        ]
        for rid in expired:
            del self._runs[rid]

    def exists(self, request_id: str) -> bool:
        """這個 request_id 是否已有 run（不論擁有者）。只給 `/api/ask` 擋重複的 request_id 用。"""
        self._purge()
        return request_id in self._runs

    def start(
        self, request_id: str, user_id: str | None, work: Callable[[AskRun], Awaitable[None]],
    ) -> AskRun:
        """建 run 並在背景跑 `work(run)`；work 結束（含拋例外、被取消）就標記結束並通知訂閱者。"""
        self._purge()
        run = AskRun(request_id, user_id, max_events=self.max_events, max_bytes=self.max_bytes)

        async def runner() -> None:
            try:
                await work(run)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("問答背景生成失敗 request_id=%s", request_id)
            finally:
                run.finish(self._clock())

        self._runs[request_id] = run
        run.task = asyncio.create_task(runner(), name=f"ask-run:{request_id}")
        return run

    def get(self, request_id: str, user_id: str | None) -> AskRun | None:
        self._purge()
        run = self._runs.get(request_id)
        if run is None or run.user_id != user_id:
            return None
        return run

    def resumable(self, request_id: str, user_id: str | None) -> AskRun | None:
        """接回用：本人的、未過期、暫存完整的 run。"""
        run = self.get(request_id, user_id)
        return None if run is None or run.overflowed else run

    async def cancel(self, request_id: str, user_id: str | None, *, timeout: float = 10.0) -> bool:
        """取消本人進行中的 run 並等它收攏（最多 `timeout` 秒）。回傳是否真的取消了一個進行中的 run。"""
        run = self.get(request_id, user_id)
        if run is None or run.finished or run.task is None or run.task.done():
            return False
        run.task.cancel()
        # asyncio.wait 不會把本協程的取消轉嫁到 task 上，也不會把 task 的 CancelledError 拋出來。
        done, _ = await asyncio.wait({run.task}, timeout=timeout)
        if not done:
            logger.warning("問答 run %s 取消後 %.0fs 內未收攏", request_id, timeout)
        else:
            with contextlib.suppress(BaseException):
                run.task.result()
        return True

    def __len__(self) -> int:
        return len(self._runs)
