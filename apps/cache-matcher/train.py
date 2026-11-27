"""Train a three-class head, choose operating points, and audit frozen thresholds on independent families."""

import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path
import tempfile

import numpy as np
from scipy.stats import beta
from sklearn.linear_model import LogisticRegression

from model import Encoder, FORMAT, LABELS, language, probabilities, profile_id, validate


def load_groups(path):
    groups = []
    seen = set()
    owners = {}
    for line_no, line in enumerate(path.read_text(encoding="utf8").splitlines(), 1):
        if not line.strip():
            continue
        group = json.loads(line)
        query = group["query"]
        candidates = group["candidates"]
        validate(query, candidates)
        if not isinstance(group.get("family"), str) or not group["family"].strip():
            raise ValueError(f"{path}:{line_no}: missing question family")
        identity = query["text"].strip().casefold()
        request_id = group.get("request_id") or identity
        if not isinstance(request_id, str) or not request_id.strip():
            raise ValueError(f"{path}:{line_no}: invalid request identity")
        owner = (group["family"], language(query))
        if request_id in owners and owners[request_id] != owner:
            raise ValueError(f"{path}:{line_no}: request changes family or language")
        owners[request_id] = owner
        if (request_id, identity) in seen:
            raise ValueError(f"{path}:{line_no}: duplicate query variant in request")
        seen.add((request_id, identity))
        group["request_id"] = request_id
        if not isinstance(group.get("exact_present", False), bool):
            raise ValueError(f"{path}:{line_no}: exact_present must be boolean")
        for c in candidates:
            if (
                c.get("label") not in LABELS
                or c["question"].strip().casefold() == identity
            ):
                raise ValueError(f"{path}:{line_no}: invalid label or exact self-match")
        groups.append(group)
    if not groups:
        raise ValueError(f"Empty labeled dataset: {path}")
    return groups


def validate_splits(*splits):
    families = set()
    questions = set()
    requests = set()
    for groups in splits:
        group_families = {g["family"] for g in groups}
        group_queries = {g["query"]["text"].strip().casefold() for g in groups}
        group_requests = {request_key(g) for g in groups}
        if (
            families & group_families
            or questions & group_queries
            or requests & group_requests
        ):
            raise ValueError(
                "Split leakage: question or family occurs in more than one split"
            )
        families.update(group_families)
        questions.update(group_queries)
        requests.update(group_requests)


def request_key(g):
    return g.get("request_id") or g["query"]["text"].strip().casefold()


def independent_rows(groups):
    # Pick a request before reading its labels, retaining every lookup variant.
    requests = {}
    for g in groups:
        key = (language(g["query"]), g["family"])
        req = request_key(g)
        if key not in requests or req < requests[key]:
            requests[key] = req
    return [
        g
        for g in groups
        if request_key(g) == requests[(language(g["query"]), g["family"])]
    ]


def encode_groups(encoder, groups):
    for g in groups:
        x, complete = encoder.encode(g["query"], g["candidates"])
        yield (
            g,
            x,
            complete,
            np.array([LABELS.index(c["label"]) for c in g["candidates"]]),
        )


def evaluate_groups(encoder, groups, head):
    events = defaultdict(list)
    for g, x, complete, y in encode_groups(encoder, groups):
        scores = probabilities(x, head.coef_, head.intercept_)
        scores[~complete] = [0, 1, 0]
        limit = 1 if g.get("exact_present") else 2
        ordered = sorted(
            (i for i, p in enumerate(scores) if np.argmax(p) == 2),
            key=lambda i: -scores[i, 2],
        )[:limit]
        events[(language(g["query"]), request_key(g))].append(
            (
                [(float(scores[i, 2]), bool(y[i] == 2)) for i in ordered],
                int(np.sum(y == 2)),
            )
        )
    return merge_requests(events)


def merge_requests(events):
    by_bucket = defaultdict(list)
    for (tag, _req), variants in events.items():
        by_bucket[tag].append(
            (
                [pair for pairs, _ in variants for pair in pairs],
                sum(n for _, n in variants),
            )
        )
    return by_bucket


def counts(groups, threshold):
    hits = wrong = correct = returned = 0
    for pairs, _ in groups:
        selected = [
            ok for score, ok in pairs if threshold is not None and score >= threshold
        ]
        hits += bool(selected)
        wrong += any(not ok for ok in selected)
        returned += len(selected)
        correct += sum(selected)
    gold = sum(n for _, n in groups)
    return {
        "queries": len(groups),
        "hits": hits,
        "wrong_hit_queries": wrong,
        "gold": gold,
        "returned": returned,
        "correct": correct,
        "wrong_among_hits": wrong / hits if hits else None,
        "source_recall": correct / gold if gold else None,
    }


def choose_threshold(groups, risk):
    events = defaultdict(list)
    for index, (pairs, _) in enumerate(groups):
        for score, correct in pairs:
            events[score].append((index, correct))
    served = set()
    wrong = set()
    best = None
    best_merit = (0, 0, 0)
    correct_sources = 0
    for score in sorted(events, reverse=True):
        for index, correct in events[score]:
            served.add(index)
            correct_sources += int(correct)
            if not correct:
                wrong.add(index)
        merit = (len(served), -len(wrong), correct_sources)
        if len(wrong) <= risk * len(served) and merit > best_merit:
            best, best_merit = score, merit
    return best


def audit_threshold(calibration, audit, risk, alpha):
    cutoff = choose_threshold(calibration, risk)
    measured = counts(audit, cutoff)
    wrong, hits = measured["wrong_hit_queries"], measured["hits"]
    upper = (
        1.0 if hits == wrong else float(beta.ppf(1 - alpha, wrong + 1, hits - wrong))
    )
    enabled = cutoff is not None and hits > 0 and upper <= risk
    return cutoff if enabled else None, {
        "proposed_threshold": cutoff,
        "enabled": enabled,
        "independent_upper_bound": upper,
        "calibration": counts(calibration, cutoff),
        "audit": measured,
    }


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf8", dir=path.parent, delete=False
    ) as file:
        staged = Path(file.name)
        json.dump(value, file, ensure_ascii=False, allow_nan=False, indent=2)
        file.write("\n")
    staged.replace(path)


def train(args):
    if not (0 < args.target_error < 1 and 0 < args.confidence < 1 and args.threads > 0):
        raise ValueError("Invalid risk, confidence or thread count")
    if len(args.embedding_version) != 64 or any(
        c not in "0123456789abcdef" for c in args.embedding_version
    ):
        raise ValueError("Expected the cache overview embedding.version SHA-256")
    splits = [load_groups(p) for p in (args.train, args.calibrate, args.audit)]
    validate_splits(*splits)
    encoder = Encoder(args.model, args.threads)
    features, targets = [], []
    for _, x, complete, y in encode_groups(encoder, splits[0]):
        features.append(x[complete])
        targets.append(y[complete])
    labels = np.concatenate(targets)
    if set(labels) != {0, 1, 2}:
        raise ValueError(
            "Training data must contain reusable, insufficient and conflict examples"
        )
    head = LogisticRegression(
        C=0.5, max_iter=1000, class_weight="balanced", solver="lbfgs", random_state=0
    )
    head.fit(np.concatenate(features).astype(np.float64), labels)
    calibration = evaluate_groups(encoder, independent_rows(splits[1]), head)
    audit = evaluate_groups(encoder, independent_rows(splits[2]), head)
    buckets = sorted(set(calibration) | set(audit))
    thresholds, results = {}, {}
    # Simultaneous one-sided Clopper-Pearson bounds on the independent audit split.
    # One erroneous source in a double hit marks the complete request as erroneous.
    alpha = (1 - args.confidence) / max(len(buckets), 1)
    for tag in buckets:
        thresholds[tag], results[tag] = audit_threshold(
            calibration[tag], audit[tag], args.target_error, alpha
        )
    profile = {
        "format": FORMAT,
        "embedding_version": args.embedding_version,
        "assets": encoder.assets,
        "labels": LABELS,
        "weights": head.coef_.tolist(),
        "bias": head.intercept_.tolist(),
        "thresholds": thresholds,
        "target_error": args.target_error,
        "confidence": args.confidence,
        "dataset": args.dataset,
    }
    revision = profile_id(profile)
    summary = {
        "profile": revision,
        "dataset": args.dataset,
        "target_error": args.target_error,
        "confidence": args.confidence,
        "classifier": "supervised multinomial head on frozen BGE cross-encoder pair representations",
        "classes": dict(
            zip(LABELS, map(int, np.bincount(labels, minlength=3)), strict=True)
        ),
        "input_sha256": {
            k: hashlib.sha256(v.read_bytes()).hexdigest()
            for k, v in [
                ("train", args.train),
                ("calibration", args.calibrate),
                ("audit", args.audit),
            ]
        },
        "buckets": results,
    }
    # The content-addressed profile is immutable and can be switched independently of the server.
    atomic_json(args.output / (revision + ".json"), profile)
    atomic_json(args.output / (revision + ".audit.json"), summary)
    print(
        json.dumps(
            {
                "profile": revision,
                "thresholds": thresholds,
                "report": str(args.output / (revision + ".audit.json")),
            }
        ),
        flush=True,
    )


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    for arg in ["model", "train", "calibrate", "audit", "output"]:
        p.add_argument("--" + arg, type=Path, required=True)
    p.add_argument(
        "--embedding-version",
        required=True,
        help="Pinned embedding.version from cache overview",
    )
    p.add_argument(
        "--dataset", required=True, help="Name/version of the labeled workload"
    )
    p.add_argument("--target-error", type=float, default=0.01)
    p.add_argument("--confidence", type=float, default=0.95)
    p.add_argument("--threads", type=int, default=4)
    train(p.parse_args())
