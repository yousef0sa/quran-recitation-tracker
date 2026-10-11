"""Inspect an ONNX streaming-zipformer export: python -I inspect_model.py <model.onnx> [--optimized-path <file>]

Prints, from the graph itself (op_type counts, not text matches):
  - ir_version, opsets, node count, op-type counts
  - quantization: weight type (QInt8/QUInt8), per-tensor vs per-channel, found by the b_zero_point shape of every
    MatMulInteger and the weight scale in its downstream Mul chain (x_scale * w_scale); the scale is not an input
    of MatMulInteger, so the chain is traced
  - inputs (x -> T frames, cached_key_0 -> left context, number of cache tensors) and outputs
  - op counts of the graph after onnxruntime's own optimizer (CPU EP, ORT_ENABLE_ALL), which shows whether
    fusions such as DynamicQuantizeMatMul / MatMulIntegerToFloat happen. The CPU optimizer is close to, but not
    identical to, the WASM build's: treat it as indicative.

Needs onnx, onnxruntime, numpy (see README.md). Reads the model only; writes the optimized graph to a temporary
directory (or --optimized-path), never into the repo. Run it with `python -I`.
"""

import argparse
import collections
import os
import sys
import tempfile

import onnx

INT_OPS_OF_INTEREST = (
    "MatMulInteger",
    "DynamicQuantizeLinear",
    "ConvInteger",
    "MatMul",
    "Conv",
    "DynamicQuantizeMatMul",
    "MatMulIntegerToFloat",
    "QLinearMatMul",
    "QLinearConv",
    "FusedMatMul",
    "QuantizeLinear",
    "DequantizeLinear",
)
WEIGHT_TYPES = {onnx.TensorProto.INT8: "QInt8", onnx.TensorProto.UINT8: "QUInt8"}


def dims_of(value_info):
    out = []
    for d in value_info.type.tensor_type.shape.dim:
        out.append(d.dim_value if d.HasField("dim_value") else (d.dim_param or "?"))
    return out


def count_ops(graph):
    return collections.Counter(node.op_type for node in graph.node)


def print_counts(title, counts):
    print(title)
    for op, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])):
        print(f"  {op:28s} {n}")


def scale_kind(shape):
    size = 1
    for d in shape:
        size *= d
    return "scalar" if size == 1 else f"vector[{size}]"


def analyse_quantization(graph):
    """Per MatMulInteger: (weight type, zero-point kind, weight-scale kind). Returns (counter, untraced node names)."""
    inits = {i.name: i for i in graph.initializer}
    producers = {}
    consumers = collections.defaultdict(list)
    for node in graph.node:
        for out in node.output:
            producers[out] = node
        for inp in node.input:
            consumers[inp].append(node)

    kinds = collections.Counter()
    untraced = []
    for node in graph.node:
        if node.op_type != "MatMulInteger":
            continue
        weight = inits.get(node.input[1])
        wtype = WEIGHT_TYPES.get(weight.data_type, f"type{weight.data_type}") if weight is not None else "not-an-initializer"
        zp_kind = "none"
        if len(node.input) > 3 and node.input[3]:
            zp = inits.get(node.input[3])
            zp_kind = scale_kind(list(zp.dims)) if zp is not None else "not-an-initializer"

        scale = "untraced"
        cast = consumers[node.output[0]]
        if len(cast) == 1 and cast[0].op_type == "Cast":
            mul = consumers[cast[0].output[0]]
            if len(mul) == 1 and mul[0].op_type == "Mul":
                others = [i for i in mul[0].input if i != cast[0].output[0]]
                src = producers.get(others[0]) if len(others) == 1 else None
                if len(others) == 1 and others[0] in inits:
                    scale = scale_kind(list(inits[others[0]].dims))
                elif src is not None and src.op_type == "Mul":
                    # x_scale * w_scale: the initializer side is the weight scale.
                    w = [i for i in src.input if i in inits]
                    if len(w) == 1:
                        scale = scale_kind(list(inits[w[0]].dims))
        if scale == "untraced":
            untraced.append(node.name)
        kinds[(wtype, zp_kind, scale)] += 1
    return kinds, untraced


def quantization_verdict(kinds):
    if not kinds:
        return "no MatMulInteger (not an int8 dynamic-quantized model)"
    per_tensor = all(zp in ("scalar", "none") and sc == "scalar" for (_, zp, sc) in kinds)
    per_channel = all(zp.startswith("vector") and sc.startswith("vector") for (_, zp, sc) in kinds)
    if per_tensor:
        return "per-tensor"
    if per_channel:
        return "per-channel"
    return "mixed or not fully traced (see the table)"


def describe_io(graph):
    init_names = {i.name for i in graph.initializer}
    inputs = [v for v in graph.input if v.name not in init_names]
    print(f"inputs: {len(inputs)}")
    by_name = {v.name: v for v in inputs}
    x = by_name.get("x")
    if x is not None:
        d = dims_of(x)
        print(f"  x {d}  -> T = {d[1] if len(d) > 1 else '?'} frames")
    key = by_name.get("cached_key_0")
    if key is not None:
        d = dims_of(key)
        print(f"  cached_key_0 {d}  -> left context = {d[0]} frames")
    groups = collections.Counter()
    for v in inputs:
        if v.name == "x":
            continue
        groups[v.name.rstrip("0123456789").rstrip("_")] += 1
    print("  other inputs (state tensors) by name prefix: " + ", ".join(f"{k} x{n}" for k, n in sorted(groups.items())))
    outputs = list(graph.output)
    print(f"outputs: {len(outputs)}")
    for v in outputs:
        if not v.name.startswith("new_"):
            print(f"  {v.name} {dims_of(v)}")
    news = [v.name for v in outputs if v.name.startswith("new_")]
    print(f"  {len(news)} state outputs (new_*), first {news[0] if news else '-'}, last {news[-1] if news else '-'}")


def optimized_counts(path, optimized_path):
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    options.optimized_model_filepath = optimized_path
    ort.InferenceSession(path, options, providers=["CPUExecutionProvider"])
    return count_ops(onnx.load(optimized_path).graph)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("model")
    parser.add_argument("--optimized-path", help="where onnxruntime writes the optimized graph (default: a temporary directory, removed afterwards)")
    parser.add_argument("--no-optimized", action="store_true", help="skip the optimized-graph op counts")
    args = parser.parse_args()

    model = onnx.load(args.model)
    graph = model.graph
    print(f"file: {os.path.basename(args.model)}  ({os.path.getsize(args.model)} bytes)")
    print(f"ir_version: {model.ir_version}  opsets: {[(o.domain or 'ai.onnx', o.version) for o in model.opset_import]}")
    print(f"nodes: {len(graph.node)}  initializers: {len(graph.initializer)}")
    counts = count_ops(graph)
    print_counts("op-type counts (graph):", counts)

    kinds, untraced = analyse_quantization(graph)
    print("quantization (per MatMulInteger: weight type, b_zero_point, weight scale):")
    for (wtype, zp, sc), n in sorted(kinds.items(), key=lambda kv: -kv[1]):
        print(f"  {n:4d} x  weight {wtype}, zero point {zp}, scale {sc}")
    if untraced:
        print(f"  could not trace the scale chain for {len(untraced)} node(s), first: {untraced[:3]}")
    print(f"=> {quantization_verdict(kinds)}")
    print(f"   activations: {counts.get('DynamicQuantizeLinear', 0)} DynamicQuantizeLinear for {counts.get('MatMulInteger', 0)} MatMulInteger")

    describe_io(graph)

    if args.no_optimized:
        return 0
    try:
        if args.optimized_path:
            opt = optimized_counts(args.model, args.optimized_path)
        else:
            with tempfile.TemporaryDirectory() as tmp:
                opt = optimized_counts(args.model, os.path.join(tmp, "optimized.onnx"))
    except Exception as err:  # the fusion check is indicative only
        print(f"optimized graph: failed ({type(err).__name__}: {err})")
        return 0
    print_counts("op-type counts (after onnxruntime CPU optimizer, ORT_ENABLE_ALL):", opt)
    fused = {op: opt.get(op, 0) for op in INT_OPS_OF_INTEREST}
    print("quantization-related ops before -> after: " + ", ".join(f"{op} {counts.get(op, 0)}->{fused[op]}" for op in INT_OPS_OF_INTEREST if counts.get(op, 0) or fused[op]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
