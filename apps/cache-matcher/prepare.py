"""Prepare the pinned BGE cross-encoder's penultimate representation for reuse training."""

import argparse
import hashlib
from pathlib import Path
import tempfile
import shutil
import urllib.request

REPO = "onnx-community/bge-reranker-v2-m3-ONNX"
REVISION = "6f5ff65298512715a1e669753bc754d2bc8f367b"
ASSETS = {
    "onnx/model_quantized.onnx": "912fc1215c2dbff6499700534bd8d31253af01573861abbfc43afd1fab6cce5d",
    "tokenizer.json": "8bf8afbfd11306bd872018c53bfdf2e160a56f8edbcf49933324404791c148d3",
}


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def prepare(directory):
    import onnx

    directory.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=directory) as scratch:
        for name, expected in ASSETS.items():
            dest = directory / Path(name).name
            if dest.exists() and digest(dest) == expected:
                continue
            staged = Path(scratch) / dest.name
            url = (
                f"https://huggingface.co/{REPO}/resolve/{REVISION}/{name}?download=true"
            )
            with urllib.request.urlopen(url, timeout=90) as response, staged.open(
                "wb"
            ) as out:
                shutil.copyfileobj(response, out)
            if digest(staged) != expected:
                raise ValueError("Downloaded asset checksum mismatch: " + name)
            staged.replace(dest)

        model = onnx.load(directory / "model_quantized.onnx")
        nodes = list(model.graph.node)
        activation = next(
            i
            for i, n in enumerate(nodes)
            if n.name == "/classifier/Tanh" and n.op_type == "Tanh"
        )
        output = nodes[activation].output[0]
        del model.graph.node[activation + 1 :]
        used = {v for n in model.graph.node for v in n.input}
        for tensor in list(model.graph.initializer):
            if tensor.name not in used:
                model.graph.initializer.remove(tensor)
        del model.graph.output[:]
        model.graph.output.append(
            onnx.helper.make_tensor_value_info(
                output, onnx.TensorProto.FLOAT, ["batch", 1024]
            )
        )
        staged = Path(scratch) / "features.onnx"
        onnx.save(model, staged)
        staged.replace(directory / "features.onnx")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    prepare(parser.parse_args().directory)
