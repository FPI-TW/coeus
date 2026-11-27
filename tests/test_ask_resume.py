"""/api/ask 帶 request_id 時生成與連線解耦、/api/ask/resume 接回、/api/ask/stop 取消背景生成（走 HTTP 層）。

httpx 的 ASGITransport 會把整個回應緩衝完才回傳，所以「斷線」用取消請求的 task 模擬：app 跑在那個 task 裡，
取消它就等於 Starlette 收到用戶端斷線、收掉串流。背景生成的 task 由 asyncio.create_task 建立，不在其中。
LLM 一律 stub（deps.answer_question）。
"""

from __future__ import annotations

import os

os.environ.setdefault("REPORT_MARK_SESSION_SECRET", "fixed-test-secret-0123456789")

import asyncio  # noqa: E402
import json  # noqa: E402
import unittest  # noqa: E402
from unittest.mock import patch  # noqa: E402

import httpx  # noqa: E402
from fake_accounts import FakeAccounts, install  # noqa: E402

import web.server as server  # noqa: E402
from app.services.ask_runs import AskRunRegistry  # noqa: E402
from app.services.quota import Decision  # noqa: E402
from web import auth, deps  # noqa: E402
from web.concurrency import ConcurrencyGate  # noqa: E402
from web.routers import ask as ask_routes  # noqa: E402

RID = "123e4567-e89b-42d3-a456-426614174000"
CONV = "13c3af97-b458-4108-836d-654a89e76fb7"
QA = "8d1f0a3c-4b2e-4c6f-9a7d-2e5b6c7d8e9f"


def _frames(body: str) -> list[tuple[str, object]]:
    out = []
    for frame in body.split("\n\n"):
        lines = frame.strip().splitlines()
        if lines and lines[0].startswith("event: "):
            out.append((lines[0][len("event: "):], json.loads(lines[1][len("data: "):])))
    return out


async def _wait_until(pred, timeout: float = 5.0) -> None:
    async def loop():
        while not pred():
            await asyncio.sleep(0.01)

    await asyncio.wait_for(loop(), timeout)


class AskResumeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        auth._FAILS.clear()
        self.store = FakeAccounts()
        self.alice = self.store.add_user("alice", "alice-password")
        self.store.add_user("bob", "bob-password")
        self._ctx = install(self.store)
        self._ctx.__enter__()

        self.release = asyncio.Event()
        self.started = asyncio.Event()
        self.seen: dict[str, object] = {}
        self.outcomes: list[str] = []

        async def fake_answer(question, **kwargs):
            self.seen["kwargs"] = kwargs
            try:
                yield ("sources", [{"n": 1}])
                yield ("token", "第一段")
                self.started.set()
                await self.release.wait()
                yield ("token", "第二段")
                self.seen["persisted"] = True  # 真的 answer_question 在送 done 之前落庫
                yield ("done", {"qa_id": QA, "conversation_id": CONV})
            except BaseException as exc:  # CancelledError（背景 task 被取消）或 GeneratorExit（綁連線的斷線）
                self.seen["interrupted"] = type(exc).__name__
                raise

        async def fake_stop(question, partial, **kwargs):
            self.seen["stop"] = {"partial": partial, **kwargs}
            return QA

        async def fake_charge(user, kind):
            self.seen.setdefault("charges", []).append(kind)
            return Decision(kind=kind, allowed=True)

        self._patches = [
            patch.object(deps, "answer_question", fake_answer),
            patch.object(deps, "log_stopped_qa", fake_stop),
            patch.object(deps.quota, "charge", fake_charge),
            patch.object(ask_routes, "_ASK_GATE", ConcurrencyGate(3, name="ask-test", max_queue=0)),
            patch.object(ask_routes, "_ASK_RUNS", AskRunRegistry(ttl=300)),
            patch.object(ask_routes.metrics, "record_qa", lambda outcome, kind=None: self.outcomes.append(outcome)),
        ]
        for p in self._patches:
            p.start()
        self.a = await self._login("alice", "alice-password")
        self.b = await self._login("bob", "bob-password")

    async def asyncTearDown(self):
        self.release.set()
        for c in (self.a, self.b):
            await c.aclose()
        for p in reversed(self._patches):
            p.stop()
        self._ctx.__exit__(None, None, None)
        auth._FAILS.clear()

    async def _login(self, username: str, password: str) -> httpx.AsyncClient:
        c = httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app), base_url="http://127.0.0.1")
        r = await c.post("/login", data={"username": username, "password": password})
        self.assertEqual(r.status_code, 303)
        return c

    def _run(self):
        return ask_routes._ASK_RUNS.get(RID, self.alice)

    async def _start_ask(self, body=None) -> asyncio.Task:
        task = asyncio.create_task(self.a.post("/api/ask", json=body or {"question": "台積電展望", "request_id": RID}))
        await asyncio.wait_for(self.started.wait(), 5)
        return task

    async def test_disconnect_does_not_cancel_generation(self):
        post = await self._start_ask()
        post.cancel()  # 重整／關分頁：串流連線斷了
        with self.assertRaises(asyncio.CancelledError):
            await post
        run = self._run()
        self.assertIsNotNone(run)
        self.assertFalse(run.task.done())
        self.release.set()
        await asyncio.wait_for(run.task, 5)
        self.assertTrue(self.seen.get("persisted"))
        self.assertNotIn("interrupted", self.seen)
        self.assertEqual(_frames("".join(run.events))[-1][0], "done")
        self.assertEqual(self.outcomes, ["ok"])

    async def test_resume_replays_backlog_then_streams_live(self):
        post = await self._start_ask()
        await _wait_until(lambda: self._run() is not None and len(self._run().events) == 2)
        resume = asyncio.create_task(self.a.get(f"/api/ask/resume/{RID}"))
        await _wait_until(lambda: len(self._run()._subscribers) == 2)
        self.release.set()
        r_post, r_resume = await asyncio.wait_for(asyncio.gather(post, resume), 5)
        self.assertEqual(r_resume.status_code, 200)
        self.assertEqual(r_resume.headers["content-type"].split(";")[0], "text/event-stream")
        self.assertEqual(r_resume.headers.get("x-accel-buffering"), "no")
        expected = [
            ("sources", [{"n": 1}]), ("token", "第一段"), ("token", "第二段"),
            ("done", {"qa_id": QA, "conversation_id": CONV}),
        ]
        self.assertEqual(_frames(r_post.text), expected)
        self.assertEqual(_frames(r_resume.text), expected)
        # 接回不扣配額
        self.assertEqual(self.seen["charges"], ["ask"])

    async def test_resume_after_finish_within_ttl(self):
        self.release.set()
        r = await self.a.post("/api/ask", json={"question": "台積電展望", "request_id": RID})
        self.assertEqual(_frames(r.text)[-1][0], "done")
        again = await self.a.get(f"/api/ask/resume/{RID}")
        self.assertEqual(again.status_code, 200)
        self.assertEqual(_frames(again.text), _frames(r.text))

    async def test_resume_is_404_for_other_user_unknown_and_malformed(self):
        post = await self._start_ask()
        for client, rid in (
            (self.b, RID),
            (self.a, "223e4567-e89b-42d3-a456-426614174000"),
            (self.a, "not-a-uuid"),
        ):
            with self.subTest(rid=rid):
                r = await client.get(f"/api/ask/resume/{rid}")
                self.assertEqual(r.status_code, 404)
        self.release.set()
        await asyncio.wait_for(post, 5)

    async def test_resume_requires_login(self):
        anon = httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app), base_url="http://127.0.0.1")
        try:
            r = await anon.get(f"/api/ask/resume/{RID}")
        finally:
            await anon.aclose()
        self.assertIn(r.status_code, (401, 303))

    async def test_stop_cancels_running_generation_then_saves_stopped_row(self):
        post = await self._start_ask()
        r = await self.a.post(
            "/api/ask/stop",
            json={"question": "台積電展望", "partial_answer": "第一段", "request_id": RID},
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"qa_id": QA})
        self.assertEqual(self.seen["interrupted"], "CancelledError")
        self.assertNotIn("persisted", self.seen)
        self.assertEqual(self.seen["stop"]["request_id"], RID)
        self.assertEqual(self.seen["stop"]["partial"], "第一段")
        run = self._run()
        self.assertTrue(run.task.cancelled())
        resp = await asyncio.wait_for(post, 5)  # 訂閱者跟著結束，不會掛住
        self.assertNotIn("done", [e for e, _ in _frames(resp.text)])
        self.assertEqual(self.outcomes, ["cancelled"])

    async def test_stop_by_other_user_does_not_cancel(self):
        post = await self._start_ask()
        await self.b.post("/api/ask/stop", json={"question": "q", "partial_answer": "", "request_id": RID})
        self.assertFalse(self._run().task.done())
        self.release.set()
        await asyncio.wait_for(post, 5)
        self.assertTrue(self.seen.get("persisted"))

    async def test_duplicate_request_id_is_409_and_not_charged(self):
        post = await self._start_ask()
        r = await self.a.post("/api/ask", json={"question": "再一次", "request_id": RID})
        self.assertEqual(r.status_code, 409)
        self.assertEqual(self.seen["charges"], ["ask"])
        self.release.set()
        await asyncio.wait_for(post, 5)

    async def test_without_request_id_generation_stays_bound_to_connection(self):
        post = await self._start_ask({"question": "舊用戶端"})
        self.assertEqual(len(ask_routes._ASK_RUNS), 0)
        post.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await post
        await _wait_until(lambda: "interrupted" in self.seen)
        self.assertNotIn("persisted", self.seen)
        self.assertEqual(self.outcomes, ["cancelled"])

    async def test_without_request_id_completes_normally(self):
        self.release.set()
        r = await self.a.post("/api/ask", json={"question": "舊用戶端"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(_frames(r.text)[-1][0], "done")
        self.assertEqual(len(ask_routes._ASK_RUNS), 0)

    async def test_llm_error_is_buffered_for_resume(self):
        from app.services.llm import LLMUnavailableError

        async def failing(question, **kwargs):
            yield ("sources", [])
            raise LLMUnavailableError("x", kind="content_filter")

        with patch.object(deps, "answer_question", failing):
            r = await self.a.post("/api/ask", json={"question": "q", "request_id": RID})
        again = await self.a.get(f"/api/ask/resume/{RID}")
        self.assertEqual(_frames(again.text), _frames(r.text))
        self.assertEqual(_frames(r.text)[-1][0], "error")
        self.assertEqual(self.outcomes, ["llm_error"])


if __name__ == "__main__":
    unittest.main()
