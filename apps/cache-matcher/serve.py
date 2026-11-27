"""Serve a trained cache reuse profile with one bounded CPU inference batch at a time."""

import argparse
import hmac
import json
import math
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from model import FORMAT, Matcher


def serve(args):
    matcher = Matcher(args.model, args.profile, args.threads)
    # Materialize the lazy CPU kernels before readiness admits a budgeted query.
    matcher.classify(
        {"text": "Readiness check"},
        [
            {
                "question_id": "ready",
                "question": "Status",
                "materials": [{"title": "Status", "snippet": ""}],
            }
        ],
    )
    key = os.environ.get("OAS_CACHE_MATCHER_API_KEY", "").encode()
    available = threading.BoundedSemaphore(1)

    class Api(BaseHTTPRequestHandler):
        def reply(self, code, result):
            data = json.dumps(
                result, ensure_ascii=False, separators=(",", ":"), allow_nan=False
            ).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_GET(self):
            if self.path == "/health/ready":
                return self.reply(200, {"ready": True, "profile": matcher.version})
            self.reply(404, {"en": "Unknown route", "zh": "路径不存在"})

        def do_POST(self):
            arrival = time.monotonic()
            if self.path != "/v1/cache/match":
                return self.reply(404, {"en": "Unknown route", "zh": "路径不存在"})
            auth = self.headers.get("Authorization", "").encode()
            if key and not hmac.compare_digest(auth, b"Bearer " + key):
                return self.reply(401, {"en": "Invalid credential", "zh": "凭据无效"})
            acquired = False
            try:
                self.connection.settimeout(2)
                size = int(self.headers.get("Content-Length", 0))
                if not 0 < size <= 256 * 1024:
                    return self.reply(
                        413, {"en": "Invalid payload size", "zh": "输入超出限制"}
                    )
                body = json.loads(self.rfile.read(size))
                if (
                    not isinstance(body, dict)
                    or body.get("profile") != matcher.version
                    or body.get("input_format") != FORMAT
                    or body.get("embedding_version")
                    != matcher.profile["embedding_version"]
                ):
                    return self.reply(
                        409, {"en": "Profile mismatch", "zh": "匹配配置版本不同"}
                    )
                budget = body["budget_ms"]
                if type(budget) is not int or budget <= 0 or budget > 2**63 - 1:
                    raise ValueError("Invalid request deadline")
                deadline = arrival + budget / 1000
                abstention = matcher.uncalibrated_response(
                    body["query"], body["candidates"]
                )
                if time.monotonic() >= deadline:
                    raise TimeoutError
                if abstention is not None:
                    return self.reply(200, abstention)
                acquired = available.acquire(blocking=False)
                if not acquired:
                    return self.reply(
                        503, {"en": "Matcher is busy", "zh": "匹配器繁忙"}
                    )
                result = matcher.classify(body["query"], body["candidates"], deadline)
                if any(
                    not math.isfinite(d["reusable_score"]) for d in result["decisions"]
                ):
                    raise RuntimeError("non-finite result")
                self.reply(200, result)
            except TimeoutError:
                self.reply(504, {"en": "Matcher deadline exceeded", "zh": "复核已超时"})
            except (ValueError, TypeError, AttributeError, KeyError):
                self.reply(
                    400, {"en": "Invalid evidence packet", "zh": "复用判断材料无效"}
                )
            except Exception:
                self.reply(503, {"en": "Inference failed", "zh": "模型推理失败"})
            finally:
                if acquired:
                    available.release()

        def log_message(self, *args):
            pass

    with ThreadingHTTPServer((args.host, args.port), Api) as server:
        print("Serving cache matcher profile " + matcher.version, flush=True)
        server.serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--profile", type=Path, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8092)
    parser.add_argument("--threads", type=int, default=4)
    serve(parser.parse_args())
