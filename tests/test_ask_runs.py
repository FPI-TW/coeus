"""進行中的問答生成登錄表（app/services/ask_runs.py）：訂閱位移、多訂閱者、TTL 清除、暫存上限、取消。"""

from __future__ import annotations

import asyncio
import unittest

from app.services.ask_runs import AskRunRegistry

RID = "123e4567-e89b-42d3-a456-426614174000"


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


async def _collect(it) -> list[str]:
    return [frame async for frame in it]


class AskRunRegistryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.clock = _Clock()
        self.reg = AskRunRegistry(ttl=300, clock=self.clock)
        self.step = asyncio.Event()

    def _start(self, frames_before=("a", "b"), frames_after=("c",), rid=RID, user="u1"):
        async def work(run):
            for f in frames_before:
                run.append(f)
            await self.step.wait()
            for f in frames_after:
                run.append(f)

        return self.reg.start(rid, user, work)

    async def test_late_subscriber_gets_backlog_then_live(self):
        run = self._start()
        await asyncio.sleep(0)
        sub = asyncio.create_task(_collect(run.subscribe()))
        await asyncio.sleep(0)
        self.step.set()
        self.assertEqual(await asyncio.wait_for(sub, 5), ["a", "b", "c"])
        self.assertTrue(run.finished)

    async def test_multiple_subscribers_each_get_everything(self):
        run = self._start()
        early = asyncio.create_task(_collect(run.subscribe()))  # 還沒任何事件時就訂閱
        await asyncio.sleep(0)
        late = asyncio.create_task(_collect(run.subscribe()))
        await asyncio.sleep(0)
        self.step.set()
        self.assertEqual(await asyncio.wait_for(early, 5), ["a", "b", "c"])
        self.assertEqual(await asyncio.wait_for(late, 5), ["a", "b", "c"])

    async def test_subscribe_after_finish_replays_and_ends(self):
        self.step.set()
        run = self._start()
        await asyncio.wait_for(run.task, 5)
        self.assertEqual(await _collect(run.subscribe()), ["a", "b", "c"])

    async def test_subscriber_disconnect_does_not_cancel_work(self):
        run = self._start()
        it = run.subscribe()
        self.assertEqual(await it.__anext__(), "a")
        await it.aclose()
        self.step.set()
        await asyncio.wait_for(run.task, 5)
        self.assertEqual(run.events, ["a", "b", "c"])
        self.assertFalse(run.task.cancelled())
        self.assertEqual(run._subscribers, set())

    async def test_owner_only(self):
        self._start(user="u1")
        self.assertIsNotNone(self.reg.get(RID, "u1"))
        self.assertIsNone(self.reg.get(RID, "u2"))
        self.assertIsNone(self.reg.get(RID, None))
        self.assertIsNone(self.reg.resumable("223e4567-e89b-42d3-a456-426614174000", "u1"))
        self.step.set()

    async def test_finished_run_expires_after_ttl(self):
        self.step.set()
        run = self._start()
        await asyncio.wait_for(run.task, 5)
        self.clock.now += 299
        self.assertIsNotNone(self.reg.resumable(RID, "u1"))
        self.clock.now += 1
        self.assertIsNone(self.reg.resumable(RID, "u1"))
        self.assertEqual(len(self.reg), 0)

    async def test_running_run_never_expires(self):
        self._start()
        await asyncio.sleep(0)
        self.clock.now += 10_000
        self.assertIsNotNone(self.reg.resumable(RID, "u1"))
        self.step.set()

    async def test_overflow_stops_buffering_but_live_subscribers_keep_receiving(self):
        reg = AskRunRegistry(ttl=300, max_events=2, clock=self.clock)

        async def work(run):
            for f in ("a", "b", "c", "d"):
                run.append(f)
                await asyncio.sleep(0)

        run = reg.start(RID, "u1", work)
        live = run.subscribe()
        got = await asyncio.wait_for(_collect(live), 5)
        self.assertEqual(got, ["a", "b", "c", "d"])
        self.assertTrue(run.overflowed)
        self.assertEqual(run.events, ["a", "b"])
        # 暫存不完整就接不回（前端退回停止路徑），但本人查得到（停止時要能取消它）。
        self.assertIsNone(reg.resumable(RID, "u1"))
        self.assertIsNotNone(reg.get(RID, "u1"))

    async def test_byte_cap(self):
        reg = AskRunRegistry(ttl=300, max_bytes=5, clock=self.clock)

        async def work(run):
            run.append("abc")
            run.append("中文")  # 6 位元組，超過

        run = reg.start(RID, "u1", work)
        await asyncio.wait_for(run.task, 5)
        self.assertTrue(run.overflowed)
        self.assertEqual(run.events, ["abc"])

    async def test_cancel_stops_work_and_ends_subscribers(self):
        run = self._start()
        sub = asyncio.create_task(_collect(run.subscribe()))
        await asyncio.sleep(0)
        self.assertTrue(await self.reg.cancel(RID, "u1"))
        self.assertTrue(run.task.cancelled())
        self.assertTrue(run.finished)
        self.assertEqual(await asyncio.wait_for(sub, 5), ["a", "b"])

    async def test_cancel_is_owner_only_and_noop_when_finished(self):
        run = self._start()
        await asyncio.sleep(0)
        self.assertFalse(await self.reg.cancel(RID, "u2"))
        self.assertFalse(run.task.done())
        self.step.set()
        await asyncio.wait_for(run.task, 5)
        self.assertFalse(await self.reg.cancel(RID, "u1"))

    async def test_work_exception_still_finishes_run(self):
        async def work(run):
            run.append("a")
            raise RuntimeError("boom")

        run = self.reg.start(RID, "u1", work)
        with self.assertLogs("app.services.ask_runs", "ERROR"):
            await asyncio.wait_for(run.task, 5)
        self.assertTrue(run.finished)
        self.assertEqual(await _collect(run.subscribe()), ["a"])


if __name__ == "__main__":
    unittest.main()
