"""Build reproducible proxy labels for matcher training and a separate question-pair check."""

import argparse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
import gzip
import hashlib
import json
from pathlib import Path
import random
import time

import pyarrow.parquet as pq
import requests

from cache_matcher_passages import passages, source_files

REVISION = "b8dd5d7af51114dbda02c0e3f6133f332186418e"
LABELS = ["reusable", "insufficient", "conflict"]


def key(text):
    return hashlib.sha256(text.strip().casefold().encode()).hexdigest()


def download(directory, item):
    lang, split = item
    path = directory / (lang + "-" + split + ".parquet")
    if not path.is_file():
        url = f"https://huggingface.co/datasets/facebook/xnli/resolve/{REVISION}/{lang}/{split}-00000-of-00001.parquet"
        for attempt in range(3):
            try:
                response = requests.get(
                    url,
                    params={"download": "true", "t": int(time.time())},
                    timeout=(20, 120),
                )
                response.raise_for_status()
                staged = path.with_suffix(".part")
                staged.write_bytes(response.content)
                staged.replace(path)
                break
            except requests.RequestException:
                if attempt == 2:
                    raise
    return path


def packet(question, title, snippet, label):
    return {
        "question_id": key(question),
        "question": question,
        "materials": [
            {"title": title[:160], "snippet": snippet[:320], "summary": None}
        ],
        "label": label,
    }


def save(path, rows):
    with path.open("w", encoding="utf8") as output:
        for row in rows:
            output.write(json.dumps(row, ensure_ascii=False) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--question-benchmark", type=Path, required=True)
    parser.add_argument("--inputs", type=Path, help="Shared public corpus cache")
    parser.add_argument("--families", type=int, default=480)
    args = parser.parse_args()
    args.directory.mkdir(exist_ok=True, parents=True)
    inputs = args.inputs or args.directory / "inputs"
    inputs.mkdir(exist_ok=True)
    splits = ["train", "validation", "test"]
    with ThreadPoolExecutor(4) as pool:
        list(
            pool.map(
                lambda item: download(inputs, item),
                [(lang, s) for s in splits for lang in ["en", "zh"]],
            )
        )
    source_files(inputs)
    public_questions = args.question_benchmark
    qa = []
    for d in [public_questions, public_questions / "comparison"]:
        qa.extend(
            json.loads((d / "questions.json").read_text(encoding="utf8"))["groups"]
        )
    held_texts = {
        t.strip().casefold()
        for g in qa
        for t in [g["query"], *g["positive"], *g["negative"]]
    }
    used_families = set()
    used_queries = set(held_texts)
    for split in splits:
        datasets = {
            lang: pq.read_table(inputs / (lang + "-" + split + ".parquet")).to_pylist()
            for lang in ("en", "zh")
        }
        assert len(datasets["en"]) == len(datasets["zh"])
        indices = list(range(len(datasets["en"])))
        random.Random(2711).shuffle(indices)
        rows = []
        selected = set()
        for index in indices:
            e = datasets["en"][index]
            family = "xnli-" + key(e["premise"])
            if family in used_families or family in selected:
                continue
            translations = [datasets[lang][index] for lang in ["en", "zh"]]
            assert translations[0]["label"] == translations[1]["label"]
            if len({t["hypothesis"].strip().casefold() for t in translations}) != len(
                translations
            ):
                continue
            if any(
                t["hypothesis"].strip().casefold() in used_queries
                or t["hypothesis"].strip().casefold() == t["premise"].strip().casefold()
                for t in translations
            ):
                continue
            selected.add(family)
            for lang, record in zip(["en", "zh"], translations, strict=True):
                h, p = record["hypothesis"], record["premise"]
                used_queries.add(h.strip().casefold())
                # An XNLI premise is labeled evidence for a claim. Keep it in the
                # evidence field; the historical title contains only its opening.
                title = p[:50]
                if title.strip().casefold() == h.strip().casefold():
                    title = p
                rows.append(
                    {
                        "family": family,
                        "query": {"text": h, "language": lang},
                        "candidates": [
                            packet(title, title, p, LABELS[record["label"]])
                        ],
                    }
                )
            if len(selected) >= args.families:
                break
        used_families.update(selected)
        # Add question-to-question supervision. Keep BOTH old published evaluation
        # sets out of training, including questions occurring as their candidates.
        with gzip.open(
            public_questions / "inputs/ubuntu.jsonl.gz", "rt", encoding="utf8"
        ) as source:
            english = [json.loads(line) for line in source]
        chinese = defaultdict(dict)
        for d in pq.read_table(public_questions / "inputs/lcqmc.parquet").to_pylist():
            chinese[d["sentence1"]][d["sentence2"]] = d["score"]
        extra = {
            "en": english,
            "zh": [
                {
                    "query": q,
                    "positive": [t for t, y in d.items() if y],
                    "negative": [t for t, y in d.items() if not y],
                }
                for q, d in chinese.items()
            ],
        }
        for lang, examples in extra.items():
            random.Random(5901).shuffle(examples)
            kept = 0
            for g in examples:
                q = g["query"].strip()
                part = int(key(q)[:8], 16) % 5
                assigned = (
                    "train" if part < 3 else "validation" if part == 3 else "test"
                )
                if assigned != split or not q or q.casefold() in used_queries:
                    continue
                items = {}
                for ls, label in [
                    ("positive", "reusable"),
                    ("negative", "insufficient"),
                ]:
                    for t in g[ls][:4]:
                        t = t.strip()
                        if (
                            t
                            and t.casefold() != q.casefold()
                            and t.casefold() not in held_texts
                        ):
                            items[t] = packet(t, t, "", label)
                if items:
                    rows.append(
                        {
                            "family": "qa-" + key(q),
                            "query": {"text": q, "language": lang},
                            "candidates": list(items.values()),
                        }
                    )
                    used_queries.add(q.casefold())
                    kept += 1
                if kept >= args.families:
                    break
        rows.extend(
            passages(inputs, split, used_queries, used_families, 2 * args.families)
        )
        name = {"train": "train", "validation": "calibrate", "test": "audit"}[split]
        save(args.directory / (name + ".jsonl"), rows)
        print(name, len(rows), flush=True)
    public = []
    for g in qa:
        q = g["query"]
        docs = [
            packet(t, t, "", label)
            for ls, label in [("positive", "reusable"), ("negative", "insufficient")]
            for t in g[ls]
        ]
        public.append(
            {
                "family": "qa-" + key(q),
                "query": {"text": q, "language": g["language"]},
                "candidates": docs,
            }
        )
    save(args.directory / "heldout-questions.jsonl", public)


if __name__ == "__main__":
    main()
