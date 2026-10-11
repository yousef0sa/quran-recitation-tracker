"""Build tilawa's io manifest for a streaming-zipformer export: python -I make_io.py <model.onnx> <out.io.json>

The manifest has the structure of tilawa's bundled `zipformer-io.json` (and of public/models/zipformer_a0w_ep1_a05.io.json):
  model, T, hop, featureDim, vocabSize, [encoderFrames], inputs, outputs.
  - T is read from the `x` input ([N, T, 80]); hop = T - 13. Only the known pairs T 61 -> hop 48 and T 45 -> hop 32 are
    accepted; anything else fails loudly (so does a missing x, a feature dim other than 80 or a vocab other than 251).
  - Symbolic or batch dimensions become 1. The state outputs new_<name> take the dims of the input <name> (the graph only
    has symbolic names for them). log_probs is [1, hop/4, 251]; a static log_probs frame count in the graph must agree.
  - Outputs are ordered log_probs, encoder output, new_* (the sort is stable, so the states keep graph order).
  - `encoderFrames` is the name of the one output that is neither `log_probs` nor `new_*` (a0w has
    `/Transpose_226_output_0`, marked optional like in the published file); the key is omitted when there is none.
  - Left context is not a field: it is baked into the cache input dims, so each export needs its own manifest.

Reads the model graph only (external data is not loaded); writes only the JSON. The model is NPL-1.2: keep the manifest next
to it in public/models/ (git-ignored). Needs onnx (see README.md). Run it with `python -I`.
"""

import json
import os
import sys

import onnx

KNOWN_HOPS = {61: 48, 45: 32}
FEATURE_DIM = 80
VOCAB_SIZE = 251
DTYPES = {
    onnx.TensorProto.FLOAT: "float32",
    onnx.TensorProto.INT64: "int64",
    onnx.TensorProto.INT32: "int32",
}


def fail(message):
    sys.exit(f"make_io: {message}")


def dims_of(value_info):
    """Static dim value, or the symbolic name (a string); -1 stands for an unnamed dim."""
    out = []
    for d in value_info.type.tensor_type.shape.dim:
        if d.HasField("dim_value"):
            out.append(d.dim_value)
        else:
            out.append(d.dim_param or -1)
    return out


def dtype_of(value_info):
    elem = value_info.type.tensor_type.elem_type
    if elem not in DTYPES:
        fail(f"{value_info.name}: unsupported element type {elem}")
    return DTYPES[elem]


def concrete(dims):
    return [d if isinstance(d, int) and d > 0 else 1 for d in dims]


def build(model_path):
    graph = onnx.load(model_path, load_external_data=False).graph
    init_names = {i.name for i in graph.initializer}
    graph_inputs = [v for v in graph.input if v.name not in init_names]
    by_name = {v.name: v for v in graph_inputs}

    if "x" not in by_name:
        fail("no input named x")
    x_dims = dims_of(by_name["x"])
    if len(x_dims) != 3 or not isinstance(x_dims[1], int) or x_dims[1] <= 0:
        fail(f"x dims {x_dims}: expected [N, T, {FEATURE_DIM}] with a static T")
    T = x_dims[1]
    if T not in KNOWN_HOPS:
        fail(f"T = {T} is not one of the known frame counts {sorted(KNOWN_HOPS)} (hop = T - 13 is only checked for those)")
    hop = T - 13
    if hop != KNOWN_HOPS[T]:
        fail(f"hop {hop} for T {T} does not match the known pair {T}/{KNOWN_HOPS[T]}")
    if x_dims[2] != FEATURE_DIM:
        fail(f"x feature dim {x_dims[2]}, expected {FEATURE_DIM}")

    inputs = [{"name": v.name, "dims": concrete(dims_of(v)), "dtype": dtype_of(v)} for v in graph_inputs]
    input_dims = {i["name"]: i["dims"] for i in inputs}

    outputs = []
    encoder = None
    frames = hop // 4
    for v in graph.output:
        name = v.name
        dims = dims_of(v)
        if name == "log_probs":
            if len(dims) != 3 or dims[2] != VOCAB_SIZE:
                fail(f"log_probs dims {dims}: expected [N, frames, {VOCAB_SIZE}]")
            if isinstance(dims[1], int) and dims[1] > 0 and dims[1] != frames:
                fail(f"log_probs has {dims[1]} frames, hop {hop} gives {frames}")
            out_dims = [1, frames, VOCAB_SIZE]
        elif name.startswith("new_"):
            state = name[len("new_"):]
            if state not in input_dims:
                fail(f"output {name} has no input {state}")
            out_dims = list(input_dims[state])
        else:
            if encoder is not None:
                fail(f"more than one extra output ({encoder}, {name}); cannot tell which is the encoder")
            encoder = name
            out_dims = concrete(dims)
            if len(dims) == 3 and not (isinstance(dims[1], int) and dims[1] > 0):
                out_dims[1] = frames
        entry = {"name": name, "dims": out_dims, "dtype": dtype_of(v)}
        if name == encoder:
            entry["optional"] = True
        outputs.append(entry)
    if not any(o["name"] == "log_probs" for o in outputs):
        fail("no output named log_probs")
    # Order of tilawa's manifest: log_probs, the encoder output (if any), then the states in graph order.
    outputs.sort(key=lambda o: 0 if o["name"] == "log_probs" else 1 if o["name"] == encoder else 2)

    manifest = {
        "model": os.path.basename(model_path),
        "T": T,
        "hop": hop,
        "featureDim": FEATURE_DIM,
        "vocabSize": VOCAB_SIZE,
    }
    if encoder is not None:
        manifest["encoderFrames"] = encoder
    manifest["inputs"] = inputs
    manifest["outputs"] = outputs
    return manifest


def main(argv):
    if len(argv) != 3:
        sys.exit(__doc__.splitlines()[0])
    manifest = build(argv[1])
    with open(argv[2], "w", encoding="utf-8", newline="\n") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
    left = manifest["inputs"][1]["dims"][0] if len(manifest["inputs"]) > 1 else "?"
    print(
        f"{argv[2]}: T {manifest['T']}, hop {manifest['hop']}, {len(manifest['inputs'])} inputs, {len(manifest['outputs'])} outputs, "
        f"encoderFrames {manifest.get('encoderFrames', '-')}, cached_key_0 dim 0 = {left}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
