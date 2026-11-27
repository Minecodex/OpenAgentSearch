"""Serve a local multilingual E5 encoder and prepare labeled, project-isolated cache queries."""
import argparse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
import gzip
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import random
import threading
import time

import numpy as np
import onnxruntime as ort
import pyarrow.parquet as pq
import requests
from tokenizers import Tokenizer


MODEL_REV = "761b726dd34fb83930e26aab4e9ac3899aa1fa78"
UBUNTU_REV = "4d853f94cd57d85ec13805aeeac3ae3e5eb4c49c"
LCQMC_REV = "17f9b096f80380fce5ed12a9be8be7784b337daf"
MODEL = f"https://huggingface.co/Xenova/multilingual-e5-small/resolve/{MODEL_REV}/"
FILES = {
    "encoder.onnx": MODEL + "onnx/model_quantized.onnx",
    "tokenizer.json": MODEL + "tokenizer.json",
    "ubuntu.jsonl.gz": f"https://huggingface.co/datasets/mteb/askubuntudupquestions-reranking/resolve/{UBUNTU_REV}/test.jsonl.gz",
    "lcqmc.parquet": f"https://huggingface.co/datasets/C-MTEB/LCQMC/resolve/{LCQMC_REV}/data/test-00000-of-00001-cb3f2553acbb3663.parquet",
}


def download(directory, name):
    target = directory / name
    if target.is_file():
        return
    for attempt in range(3):
        try:
            with requests.get(FILES[name], stream=True, timeout=(20, 120),
                              params={"download": "true", "t": int(time.time())}) as response:
                response.raise_for_status()
                with target.with_suffix(".part").open("wb") as stream:
                    for chunk in response.iter_content(1024 * 1024):
                        stream.write(chunk)
            target.with_suffix(".part").replace(target)
            return
        except requests.RequestException:
            if attempt == 2:
                raise


def questions(directory, groups_per_class, seed=2711, excluded=()):
    with gzip.open(directory / "ubuntu.jsonl.gz", "rt", encoding="utf8") as stream:
        english = [json.loads(line) for line in stream]
    pairs = defaultdict(dict)
    for row in pq.read_table(directory / "lcqmc.parquet").to_pylist():
        pairs[row["sentence1"]][row["sentence2"]] = row["score"]
    chinese = [{"query": query, "positive": [t for t, v in values.items() if v],
                "negative": [t for t, v in values.items() if not v]} for query, values in pairs.items()]
    result = []
    rng = random.Random(seed)
    for lang, rows in [("en", english), ("zh", chinese)]:
        rng.shuffle(rows)
        used = set(excluded)
        for count in (2, 1, 0):
            kept = 0
            for row in rows:
                q = row["query"].strip()
                if q in used:
                    continue
                positives = list(dict.fromkeys(t.strip() for t in row["positive"] if t.strip() and t.strip() != q))
                negatives = list(dict.fromkeys(t.strip() for t in row["negative"] if t.strip() and t.strip() != q and t.strip() not in positives))
                if len(positives) < count or (not negatives and (count == 0 or lang == "en")):
                    continue
                used.add(q)
                result.append({"language": lang, "query": q, "positive": positives[:count], "negative": negatives[:5]})
                kept += 1
                if kept == groups_per_class:
                    break
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18792)
    parser.add_argument("--groups-per-class", type=int, default=16)
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args()
    inputs = args.directory / "inputs"
    inputs.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda name: download(inputs, name), FILES))
    corpus = {"model_revision": MODEL_REV, "ubuntu_revision": UBUNTU_REV, "lcqmc_revision": LCQMC_REV,
              "groups": questions(inputs, args.groups_per_class)}
    (args.directory / "questions.json").write_text(json.dumps(corpus, ensure_ascii=False), encoding="utf8")
    comparison = args.directory / "comparison"
    comparison.mkdir(exist_ok=True)
    second = questions(inputs, args.groups_per_class, seed=1107, excluded={g["query"] for g in corpus["groups"]})
    (comparison / "questions.json").write_text(json.dumps({**corpus, "groups":second}, ensure_ascii=False), encoding="utf8")
    if args.prepare_only:
        return
    tokenizer = Tokenizer.from_file(str(inputs / "tokenizer.json"))
    tokenizer.enable_truncation(max_length=512)
    tokenizer.enable_padding(pad_id=1, pad_token="<pad>")
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    model = ort.InferenceSession(str(inputs / "encoder.onnx"), options, providers=["CPUExecutionProvider"])
    lock = threading.Lock()

    class Api(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_POST(self):
            if self.path != "/v1/embeddings":
                self.send_error(404)
                return
            batch = json.loads(self.rfile.read(int(self.headers["Content-Length"])))["input"]
            with lock:
                tokens = tokenizer.encode_batch(["query: " + text for text in batch])
                ids = np.asarray([t.ids for t in tokens], dtype=np.int64)
                mask = np.asarray([t.attention_mask for t in tokens], dtype=np.int64)
                hidden = model.run(None, {"input_ids": ids, "attention_mask": mask,
                                          "token_type_ids": np.zeros_like(mask)})[0]
                pooled = (hidden * mask[:, :, None]).sum(axis=1) / mask.sum(axis=1)[:, None]
                pooled /= np.linalg.norm(pooled, axis=1, keepdims=True)
            body = json.dumps({"data": [{"index": i, "embedding": v.tolist()} for i, v in enumerate(pooled)]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    with ThreadingHTTPServer((args.host, args.port), Api) as server:
        print(f"Ready: {len(corpus['groups'])} labeled groups, port {args.port}", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
