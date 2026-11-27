"""Extract public, passage-grounded proxy labels. Preserve explicit unanswerable examples."""

from collections import defaultdict
import hashlib
import json
import random
import tarfile
import time

import pyarrow.parquet as pq
import requests

SQUAD = "https://huggingface.co/datasets/rajpurkar/squad_v2/resolve/3ffb306f725f7d2ce8394bc1873b24868140c412/squad_v2/"
SOURCES = {
    "squad-train.parquet": (
        SQUAD + "train-00000-of-00001.parquet",
        "f6da32ffb482ff463ad056477740d1bb284b96a45db3a08bee6a225ca6abf291",
    ),
    "squad-validation.parquet": (
        SQUAD + "validation-00000-of-00001.parquet",
        "0560174ab095c5ac0a8c8dc8da05f1625453c45a77e4ce9cabc6947ddfdd24cb",
    ),
    "dureader_checklist.tar.gz": (
        "https://dataset-bj.cdn.bcebos.com/lic2021/dureader_checklist.dataset.tar.gz",
        "d51553cfe1e025f8706e40417da065cbd097240ab2bf99077744489ada0e0ede",
    ),
}


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def source_files(directory):
    for name, (url, expected) in SOURCES.items():
        path = directory / name
        if path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == expected:
            continue
        for attempt in range(3):
            try:
                response = requests.get(
                    url,
                    params={"download": "true", "t": int(time.time())},
                    timeout=(20, 90),
                )
                response.raise_for_status()
                if hashlib.sha256(response.content).hexdigest() != expected:
                    raise ValueError("Public dataset checksum mismatch: " + name)
                staged = path.with_suffix(".part")
                staged.write_bytes(response.content)
                staged.replace(path)
                break
            except requests.RequestException:
                if attempt == 2:
                    raise


def passages(inputs, split, used_queries, used_families, max_count):
    source = "validation" if split == "test" else "train"
    english = defaultdict(list)
    for row in pq.read_table(inputs / ("squad-" + source + ".parquet")).to_pylist():
        english[(row["title"], row["context"])].append(
            (row["question"], row["answers"]["text"])
        )
    chinese = defaultdict(list)
    with tarfile.open(inputs / "dureader_checklist.tar.gz") as archive:
        name = "dataset/dev.json" if split == "test" else "dataset/train.json"
        for article in json.load(archive.extractfile(name))["data"]:
            for paragraph in article["paragraphs"]:
                for row in paragraph["qas"]:
                    answers = (
                        []
                        if row["is_impossible"]
                        else [a["text"] for a in row["answers"] if a.get("text")]
                    )
                    if answers or row["is_impossible"]:
                        chinese[
                            (
                                paragraph.get("title") or article.get("title") or "",
                                paragraph["context"],
                            )
                        ].append((row["question"], answers))
    output = []
    for lang, docs in [("en", english), ("zh", chinese)]:
        items = list(docs.items())
        rng = random.Random(2711)
        rng.shuffle(items)
        kept = 0
        for (title, body), qas in items:
            family = "passage-" + sha(body.strip())
            if family in used_families:
                continue
            if split != "test" and (int(family[-8:], 16) % 3 == 0) != (
                split == "validation"
            ):
                continue
            title = title.replace("_", " ").strip()[:160]
            snippet = body[:320]
            if not snippet.strip():
                continue
            rng.shuffle(qas)
            for question, answers in qas:
                q = question.strip()
                if not q or q.casefold() in used_queries:
                    continue
                if answers and not any(
                    t and t.casefold() in (title + " " + snippet).casefold()
                    for t in answers
                ):
                    continue
                old = next(
                    (other for other, a in qas if a and other != question), title
                )
                if not old.strip() or old.strip().casefold() == q.casefold():
                    continue
                item = {
                    "question_id": sha(old),
                    "question": old,
                    "materials": [
                        {"title": title, "snippet": snippet, "summary": None}
                    ],
                    "label": "reusable" if answers else "insufficient",
                }
                output.append(
                    {
                        "family": family,
                        "query": {"text": q, "language": lang},
                        "candidates": [item],
                    }
                )
                used_queries.add(q.casefold())
                used_families.add(family)
                kept += 1
                break
            if kept >= max_count:
                break
    return output
