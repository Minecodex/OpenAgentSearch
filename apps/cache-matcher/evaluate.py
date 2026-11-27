"""Evaluate a published profile on new labeled query families, including abstentions."""

import argparse
import json
from pathlib import Path
from time import perf_counter
from collections import defaultdict
import numpy as np

from model import Matcher, language, probabilities
from train import counts, load_groups, atomic_json, merge_requests, request_key


def evaluate(args):
    api = Matcher(args.model, args.profile, args.threads)
    seen = defaultdict(list)
    ranked = defaultdict(list)
    timings = defaultdict(list)
    for group in load_groups(args.data):
        query, candidates = group["query"], group["candidates"]
        tag = language(query)
        start = perf_counter()
        features, complete = api.encoder.encode(query, candidates)
        scores = probabilities(features, api.weights, api.bias)
        scores[~complete] = [0, 1, 0]
        timings[tag].append((perf_counter() - start) * 1000)
        truth = [c["label"] == "reusable" for c in candidates]
        indices = sorted(range(len(truth)), key=lambda i: -scores[i, 2])
        limit = 1 if group.get("exact_present") else 2
        ranked[(tag, request_key(group))].append(
            ([(float(scores[i, 2]), truth[i]) for i in indices[:limit]], sum(truth))
        )
        passing = [i for i in indices if np.argmax(scores[i]) == 2][:limit]
        seen[(tag, request_key(group))].append(
            ([(float(scores[i, 2]), truth[i]) for i in passing], sum(truth))
        )
    seen, ranked = merge_requests(seen), merge_requests(ranked)
    result = {"profile": api.version, "dataset": api.profile["dataset"], "buckets": {}}
    for tag, groups in seen.items():
        result["buckets"][tag] = {
            "top_two_before_abstention": counts(ranked[tag], 0),
            "production_decisions": counts(groups, api.profile["thresholds"].get(tag)),
            "group_model_ms_p50_p95_p99": np.quantile(timings[tag], [0.5, 0.95, 0.99])
            .round(1)
            .tolist(),
        }
    atomic_json(args.output, result)
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    for arg in ["model", "profile", "data", "output"]:
        p.add_argument("--" + arg, type=Path, required=True)
    p.add_argument("--threads", type=int, default=4)
    evaluate(p.parse_args())
