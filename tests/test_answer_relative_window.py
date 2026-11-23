"""相對時間窗的歷史題判斷（answer.is_historical_question）與問答路徑的串接。

時間窗本身（select_reports）在 tests/test_select_reports.py 的 RelativeWindowTests，
rerank head 的一致性在 tests/test_retrieval_pipeline.py。
"""

from __future__ import annotations

import dataclasses
import unittest
from datetime import date
from unittest import mock

from test_ask_web_search import _CorpusPatch

from app import config
from app.services import answer as ans
from app.services import retrieval_pipeline as rp
from app.services import scope_router as sr
from app.services.answer import is_historical_question

_TODAY = date(2026, 11, 23)


class HistoricalQuestionTests(unittest.TestCase):
    def _hit(self, q):
        return is_historical_question(q, _TODAY)

    def test_years_before_this_year(self):
        for q in ("2024 年台積電營收", "台積電2023年毛利率", "2025Q3 財報重點", "2019 年的評等"):
            with self.subTest(q=q):
                self.assertTrue(self._hit(q))

    def test_this_or_future_year_is_not_historical(self):
        for q in ("2026 年營收預估", "2027 年展望", "台積電 2026 展望"):
            with self.subTest(q=q):
                self.assertFalse(self._hit(q))

    def test_numbers_that_are_not_years(self):
        for q in (
            "目標價 2,600",
            "目標價 2,024 元",
            "20240101_台積電.pdf 的重點",
            "研報 120240 號",
            "營收 2000 億",
            "股價 1990 元",
            "每股 2024.5",
        ):
            with self.subTest(q=q):
                self.assertFalse(self._hit(q))

    def test_relative_past_terms(self):
        for q in (
            "去年毛利率", "前年的配息", "歷年配息", "台積電歷史本益比", "今年以來的漲幅",
            "過去 3 年營收", "過去三年營收", "過去十年", "過去兩年",
        ):
            with self.subTest(q=q):
                self.assertTrue(self._hit(q))

    def test_english_minimal_set(self):
        for q in ("TSMC revenue last year", "Historical PE of TSMC", "since 2026", "TSMC 2024 capex"):
            with self.subTest(q=q):
                self.assertTrue(self._hit(q))
        for q in ("TSMC outlook", "lastly", "TSMC 2026 guidance"):
            with self.subTest(q=q):
                self.assertFalse(self._hit(q))

    def test_plain_questions_are_not_historical(self):
        for q in ("台積電最新展望", "聯發科目標價", "過去幾年", "最近的評等變化", "AI 伺服器需求"):
            with self.subTest(q=q):
                self.assertFalse(self._hit(q))

    def test_year_boundary_follows_today(self):
        self.assertTrue(is_historical_question("2026 年營收", date(2027, 1, 1)))
        self.assertFalse(is_historical_question("2026 年營收", date(2026, 1, 1)))


class AnswerWindowWiringTests(unittest.IsolatedAsyncioTestCase):
    """answer_question：歷史題傳 0、其餘傳 ASK_RELATIVE_WINDOW_DAYS；qa_log.filters 記兩個觀測鍵。"""

    async def _ask(self, question, *, window=365):
        seen = {}
        real = rp.retrieve_context

        async def spy(q, **kw):
            seen.update(kw)
            out = await real(q, **kw)
            kw["stats"]["relative_window_dropped"] = 4  # 選篇寫入的值，這裡換成可辨識的數
            return out

        settings = dataclasses.replace(config.get_settings(), qa_agentic_enabled=False)
        orig = ans.ASK_RELATIVE_WINDOW_DAYS
        ans.ASK_RELATIVE_WINDOW_DAYS = window
        try:
            with mock.patch.object(config, "_SETTINGS", settings), \
                    mock.patch.object(rp, "retrieve_context", spy), \
                    _CorpusPatch(sr._decision(sr.CORPUS_QA, decided_by=sr.BY_LLM)) as pt:
                _ = [e async for e in ans.answer_question(question)]
        finally:
            ans.ASK_RELATIVE_WINDOW_DAYS = orig
        return seen["relative_window_days"], pt.called["log_filters"]

    async def test_regular_question_uses_the_knob(self):
        days, filters = await self._ask("台積電最新展望", window=200)
        self.assertEqual(days, 200)
        self.assertIs(filters["historical_question"], False)
        self.assertEqual(filters["relative_window_dropped"], 4)

    async def test_historical_question_turns_the_window_off(self):
        days, filters = await self._ask("台積電去年的毛利率")
        self.assertEqual(days, 0)
        self.assertIs(filters["historical_question"], True)


if __name__ == "__main__":
    unittest.main()
