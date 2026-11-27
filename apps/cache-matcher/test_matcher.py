import unittest
from types import SimpleNamespace

import numpy as np

from model import Matcher, language, profile_id, validate
from train import (
    audit_threshold,
    choose_threshold,
    counts,
    independent_rows,
    validate_splits,
    merge_requests,
)


def group(family, query, language_tag="en"):
    return {
        "family": family,
        "query": {"text": query, "language": language_tag},
        "candidates": [
            {
                "question_id": "S1",
                "question": "Earlier question",
                "materials": [{"title": "Guide", "snippet": "A page", "summary": None}],
                "label": "reusable",
            }
        ],
    }


class CalibrationTests(unittest.TestCase):
    def test_wrong_second_source_counts_as_one_wrong_served_query(self):
        cases = [
            ([(0.99, True), (0.97, False)], 1),
            ([(0.98, True), (0.96, True)], 2),
            ([], 0),
        ]
        self.assertEqual(counts(cases, 0.95)["wrong_among_hits"], 0.5)
        self.assertEqual(choose_threshold(cases, 0.01), 0.98)
        self.assertEqual(counts(cases, 0.98)["hits"], 2)

    def test_all_variants_of_one_served_request_share_one_error(self):
        first = group("family", "variant one")
        second = group("family", "variant two")
        first["request_id"] = second["request_id"] = "request-a"
        third = {**group("family", "later request"), "request_id": "request-b"}
        self.assertEqual(independent_rows([first, second, third]), [first, second])
        rows = merge_requests(
            {("en", "request-a"): [([(0.9, True)], 1), ([(0.95, False)], 0)]}
        )
        self.assertEqual(counts(rows["en"], 0.7)["wrong_among_hits"], 1)

    def test_independent_upper_bound_can_disable_a_zero_error_calibration(self):
        one = ([(0.95, True)], 1)
        cutoff, report = audit_threshold([one] * 400, [one] * 30, 0.01, 0.025)
        self.assertIsNone(cutoff)
        self.assertEqual(report["audit"]["wrong_hit_queries"], 0)
        self.assertGreater(report["independent_upper_bound"], 0.01)
        cutoff, report = audit_threshold([one] * 400, [one] * 400, 0.01, 0.025)
        self.assertEqual(cutoff, 0.95)
        self.assertLess(report["independent_upper_bound"], 0.01)
        self.assertIsNone(audit_threshold([one] * 400, [], 0.01, 0.025)[0])

    def test_families_and_identical_queries_do_not_cross_splits(self):
        rows = [
            group("a", "query one"),
            group("a", "query two"),
            group("a", "第三问", "zh"),
        ]
        self.assertEqual(len(independent_rows(rows)), 2)
        for other in [group("a", "unrelated wording"), group("b", " QUERY ONE ")]:
            with self.assertRaises(ValueError):
                validate_splits(rows, [other])

    def test_thresholds_and_input_format_are_part_of_the_profile_identity(self):
        p = {"format": "one", "thresholds": {"en": 0.9, "zh": None}}
        self.assertNotEqual(
            profile_id(p), profile_id({**p, "thresholds": {"en": 0.8, "zh": None}})
        )
        self.assertNotEqual(profile_id(p), profile_id({**p, "format": "two"}))
        self.assertEqual(language({"text": "Hello"}), "und")
        self.assertEqual(language({"language": "zh-Hans"}), "zh")

    def test_online_uncalibrated_language_skips_inference_and_keeps_input_validation(
        self,
    ):
        matcher = Matcher.__new__(Matcher)
        matcher.profile = {"thresholds": {"en": None, "zh": 0.9}}
        matcher.version = "test"
        g = group("a", "question")
        self.assertEqual(
            matcher.uncalibrated_response(g["query"], g["candidates"]),
            {
                "profile": "test",
                "threshold": None,
                "decisions": [],
            },
        )
        self.assertIsNone(
            matcher.uncalibrated_response(
                {"text": "问题", "language": "zh"}, g["candidates"]
            )
        )
        with self.assertRaises(ValueError):
            matcher.uncalibrated_response(g["query"], [])

    def test_uncalibrated_scores_are_visible_and_truncated_questions_abstain(self):
        matcher = Matcher.__new__(Matcher)
        matcher.encoder = SimpleNamespace(
            encode=lambda *args: (np.eye(3), np.array([True, True, False]))
        )
        matcher.profile = {"thresholds": {"en": None}}
        matcher.version = "test"
        matcher.weights = np.array([[4, 0, 0], [0, 0, 0], [0, 4, 4]])
        matcher.bias = np.zeros(3)
        g = group("a", "question")
        candidates = [{**g["candidates"][0], "question_id": str(i)} for i in range(3)]
        response = matcher.classify(g["query"], candidates)
        self.assertIsNone(response["threshold"])
        self.assertEqual(
            [d["label"] for d in response["decisions"]],
            ["conflict", "reusable", "insufficient"],
        )
        self.assertEqual(response["decisions"][2]["reusable_score"], 0)
        with self.assertRaises(ValueError):
            validate(g["query"], [candidates[0], candidates[0]])


if __name__ == "__main__":
    unittest.main()
