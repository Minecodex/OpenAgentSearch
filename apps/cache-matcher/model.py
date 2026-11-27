"""Versioned UTF-8 evidence packing and the trained three-way reuse classifier."""

import hashlib
import json
import threading
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer
from prepare import digest

FORMAT = "oas-cache-material-v1"
LABELS = ["conflict", "insufficient", "reusable"]
MAX_CANDIDATES = 8


def language(query):
    tag = query.get("language") or "und"
    if not isinstance(tag, str):
        raise ValueError("invalid language")
    return tag.split("-")[0].lower()


def bounded(value, limit):
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError("invalid text field")
    return value


def validate(query, candidates):
    if not isinstance(query, dict) or not bounded(query.get("text"), 2048).strip():
        raise ValueError("invalid query")
    language(query)
    if not isinstance(candidates, list) or not 1 <= len(candidates) <= MAX_CANDIDATES:
        raise ValueError("invalid candidate count")
    seen = set()
    for c in candidates:
        key = bounded(c["question_id"], 128)
        if not key or key in seen or not bounded(c["question"], 2048).strip():
            raise ValueError("invalid candidate identity")
        seen.add(key)
        if not isinstance(c["materials"], list) or not 1 <= len(c["materials"]) <= 3:
            raise ValueError("invalid material count")
        for m in c["materials"]:
            fields = [
                bounded(m["title"], 160),
                bounded(m["snippet"], 320),
                bounded(m.get("summary") or "", 320),
            ]
            if not any(v.strip() for v in fields):
                raise ValueError("empty evidence")


class Encoder:
    def __init__(self, directory, threads=4):
        graph = directory / "features.onnx"
        tokenizer = directory / "tokenizer.json"
        self.assets = {
            "features_sha256": digest(graph),
            "tokenizer_sha256": digest(tokenizer),
        }
        self.tok = Tokenizer.from_file(str(tokenizer))
        self.tok.no_padding()
        self.tok.no_truncation()
        self.start = self.tok.token_to_id("<s>")
        self.end = self.tok.token_to_id("</s>")
        self.pad = self.tok.token_to_id("<pad>")
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        self.session = ort.InferenceSession(
            str(graph), options, providers=["CPUExecutionProvider"]
        )
        self.inputs = [v.name for v in self.session.get_inputs()]

    def encode(self, query, candidates, deadline=None):
        validate(query, candidates)

        def tokens(text):
            return self.tok.encode(text, add_special_tokens=False).ids

        current = tokens(query["text"])
        first = [self.start] + current[:80] + [self.end, self.end]
        complete = []
        pairs = []
        for c in candidates:
            history = tokens(c["question"])
            complete.append(len(current) <= 80 and len(history) <= 64)
            pair = first + history[:64]
            for m in c["materials"]:
                for text, limit in [
                    (m["title"], 20),
                    (m["snippet"], 32),
                    (m.get("summary") or "", 24),
                ]:
                    if text:
                        pair += [self.end] + tokens(text)[:limit]
            pairs.append(pair + [self.end])
        size = max(map(len, pairs))
        ids = np.asarray(
            [p + [self.pad] * (size - len(p)) for p in pairs], dtype=np.int64
        )
        mask = np.asarray(
            [[1] * len(p) + [0] * (size - len(p)) for p in pairs], dtype=np.int64
        )
        inputs = {
            "input_ids": ids,
            "attention_mask": mask,
            "token_type_ids": np.zeros_like(mask),
        }
        feed = {name: inputs[name] for name in self.inputs}
        options = ort.RunOptions()
        timer = None
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Inference budget exhausted")
            timer = threading.Timer(
                remaining, setattr, args=(options, "terminate", True)
            )
            timer.daemon = True
            timer.start()
        try:
            features = self.session.run(None, feed, options)[0]
        except Exception as exc:
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError("Inference budget exhausted") from exc
            raise
        finally:
            if timer is not None:
                timer.cancel()
        if deadline is not None and time.monotonic() >= deadline:
            raise TimeoutError("Inference budget exhausted")
        return features, np.asarray(complete, dtype=bool)


def profile_id(profile):
    encoded = json.dumps(
        profile,
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def probabilities(features, weights, bias):
    logits = (
        np.asarray(features, dtype=np.float64) @ np.asarray(weights, dtype=np.float64).T
        + bias
    )
    logits -= np.max(logits, axis=1, keepdims=True)
    exp = np.exp(logits)
    return exp / np.sum(exp, axis=1, keepdims=True)


class Matcher:
    def __init__(self, directory, profile_file, threads=4):
        self.encoder = Encoder(directory, threads)
        self.profile = json.loads(Path(profile_file).read_text(encoding="utf8"))
        self.version = profile_id(self.profile)
        embedding_version = self.profile["embedding_version"]
        if len(embedding_version) != 64 or any(
            c not in "0123456789abcdef" for c in embedding_version
        ):
            raise ValueError("Invalid embedding version")
        if (
            self.profile["format"] != FORMAT
            or self.profile["labels"] != LABELS
            or self.encoder.assets != self.profile["assets"]
        ):
            raise ValueError("Incompatible classifier assets or input format")
        self.weights = np.asarray(self.profile["weights"], dtype=np.float64)
        self.bias = np.asarray(self.profile["bias"], dtype=np.float64)
        if (
            self.weights.shape != (3, 1024)
            or self.bias.shape != (3,)
            or not all(np.isfinite(a).all() for a in (self.weights, self.bias))
        ):
            raise ValueError("Invalid classifier head")
        for v in self.profile["thresholds"].values():
            if v is not None and not 0 <= v <= 1:
                raise ValueError("Invalid calibration threshold")

    def uncalibrated_response(self, query, candidates):
        if self.profile["thresholds"].get(language(query)) is not None:
            return None
        validate(query, candidates)
        return {"profile": self.version, "threshold": None, "decisions": []}

    def classify(self, query, candidates, deadline=None):
        validate(query, candidates)
        threshold = self.profile["thresholds"].get(language(query))
        features, complete = self.encoder.encode(query, candidates, deadline)
        scores = probabilities(features, self.weights, self.bias)
        scores[~complete] = [0, 1, 0]
        decisions = [
            {
                "question_id": c["question_id"],
                "label": LABELS[int(np.argmax(row))],
                "reusable_score": float(row[2]),
            }
            for row, c in zip(scores, candidates, strict=True)
        ]
        return {"profile": self.version, "threshold": threshold, "decisions": decisions}
