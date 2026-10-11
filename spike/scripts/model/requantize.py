"""Rewrite a dynamic-int8 zipformer export: python -I requantize.py <command> ...

  dequantize <in.int8.onnx> <out.onnx>
      Replace every DynamicQuantizeLinear + MatMulInteger (+ its Cast and the x_scale*w_scale Mul chain) with a float
      MatMul whose weight is (W_int8 - zero_point) * scale. The weights are the int8-rounded ones, so this is a SPEED
      question (is a float graph faster than dynamic int8 here?), not the official fp32 model's accuracy.
      Handles one DynamicQuantizeLinear feeding several MatMulInteger (it is removed only when no consumer is left),
      leaves the float activation x activation MatMul nodes and the Conv nodes alone, keeps the source ir_version and
      opset, removes the dead int8 initializers, runs onnx.checker, and fails loudly (listing node names, writing
      nothing) when the graph does not match the expected pattern.

  dynamic <in.onnx> <out.onnx> [--per-tensor | --per-channel] [--weight-type qint8|quint8]
      onnxruntime quantize_dynamic with op_types_to_quantize=["MatMul"] only (its defaults would also turn the Conv nodes
      into ConvInteger, a different graph). Per-tensor by default. Use the weight type that inspect_model.py prints for
      the shipped model. Only needed when the shipped model is per-channel.

  smoke <a.onnx> <b.onnx> [--steps 50] [--seed 0]
      Rolls both models over the same random inputs for N consecutive steps, carrying their own cache states (zeros at
      the start). Passes when the shapes match, there is no NaN and the mean abs log-prob difference is < 0.5. The
      argmax agreement and the max abs difference are reported but not gated (on random input the argmax is mostly
      blank). The real equivalence test is the bench run on real recordings.

Needs onnx, onnxruntime, numpy (see README.md). Outputs go where you point them (spike/public/models/ is git-ignored).
Run it with `python -I`.
"""

import argparse
import collections
import os
import sys

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

WEIGHT_TYPES = (TensorProto.INT8, TensorProto.UINT8)
MEAN_ABS_LIMIT = 0.5
BLANK_ID = 250


class PatternError(Exception):
    pass


def count_ops(model):
    return collections.Counter(node.op_type for node in model.graph.node)


def format_counts(counts, ops=("MatMulInteger", "DynamicQuantizeLinear", "ConvInteger", "Conv", "MatMul")):
    return ", ".join(f"{op}={counts.get(op, 0)}" for op in ops)


def shape_ok(dims, n):
    """Scalar (or one element) or a vector over the last axis of the weight."""
    return len(dims) == 0 or list(dims) == [1] or list(dims) == [n]


def dequantize(src, dst):
    if os.path.abspath(src) == os.path.abspath(dst):
        raise SystemExit("refusing to overwrite the input model")
    model = onnx.load(src)
    graph = model.graph
    ir_version = model.ir_version
    opsets = [(o.domain, o.version) for o in model.opset_import]
    before = count_ops(model)

    inits = {i.name: i for i in graph.initializer}
    producers = {}
    consumers = collections.defaultdict(list)
    for index, node in enumerate(graph.node):
        for out in node.output:
            producers[out] = index
        for inp in node.input:
            consumers[inp].append(index)
    graph_outputs = {o.name for o in graph.output}

    problems = []
    plans = []
    for index, node in enumerate(graph.node):
        if node.op_type != "MatMulInteger":
            continue
        label = node.name or f"#{index}"
        try:
            plans.append(match(graph, node, index, label, inits, producers, consumers, graph_outputs))
        except PatternError as err:
            problems.append(f"{label}: {err}")
    if before.get("MatMulInteger", 0) == 0:
        problems.append("no MatMulInteger in the graph: not a dynamic-int8 export")
    leftovers = [n for n in ("ConvInteger", "QLinearMatMul", "QLinearConv") if before.get(n, 0)]
    if leftovers:
        problems.append(f"unsupported quantized ops present: {leftovers}")
    if problems:
        shown = "\n  ".join(problems[:40])
        raise SystemExit(f"dequantize: {len(problems)} unmatched pattern(s), nothing written:\n  {shown}")

    # New float weights, one per distinct int8 weight tensor.
    new_weights = {}
    for plan in plans:
        key = plan["weight"]
        if key in new_weights:
            continue
        w = numpy_helper.to_array(inits[key]).astype(np.float32)
        zp = numpy_helper.to_array(inits[plan["w_zp"]]).astype(np.float32)
        scale = numpy_helper.to_array(inits[plan["w_scale"]]).astype(np.float32)
        name = f"{key}_deq"
        if name in inits:
            raise SystemExit(f"dequantize: initializer name {name} already exists, nothing written")
        new_weights[key] = numpy_helper.from_array(((w - zp) * scale).astype(np.float32), name)

    removed = set()
    replaced = {}
    for plan in plans:
        removed.update((plan["mmi"], plan["cast"], plan["out_mul"]))
        replaced[plan["out_mul"]] = helper.make_node(
            "MatMul",
            [plan["activation"], new_weights[plan["weight"]].name],
            [graph.node[plan["out_mul"]].output[0]],
            name=f"{graph.node[plan['mmi']].name or plan['mmi']}_deq",
        )
    candidates = {plan["scales_mul"] for plan in plans} | {plan["dql"] for plan in plans}

    kept = []  # (index in the source graph, node copy)
    for i, node in enumerate(graph.node):
        if i in replaced:
            kept.append((i, replaced[i]))
        elif i not in removed:
            copy = onnx.NodeProto()
            copy.CopyFrom(node)
            kept.append((i, copy))

    # Dead-node removal for the shared helpers only (the scale Mul and the DynamicQuantizeLinear).
    changed = True
    while changed:
        changed = False
        used = set(graph_outputs)
        for _, node in kept:
            used.update(node.input)
        for entry in list(kept):
            i, node = entry
            if i in candidates and not any(out in used for out in node.output):
                kept.remove(entry)
                changed = True
    nodes = [node for _, node in kept]

    graph.ClearField("node")
    graph.node.extend(nodes)
    remaining = count_ops(model)
    for op in ("MatMulInteger", "DynamicQuantizeLinear"):
        if remaining.get(op, 0):
            left = [n.name for n in nodes if n.op_type == op][:10]
            raise SystemExit(f"dequantize: {remaining[op]} {op} node(s) remain after the rewrite, nothing written: {left}")
    expected_matmul = before.get("MatMul", 0) + before["MatMulInteger"]
    if remaining.get("MatMul", 0) != expected_matmul:
        raise SystemExit(f"dequantize: MatMul count {remaining.get('MatMul', 0)} != expected {expected_matmul}, nothing written")

    # Initializers: add the float weights, drop everything no node uses any more.
    used_inputs = {i for n in nodes for i in n.input}
    keep = []
    for init in graph.initializer:
        if init.name in used_inputs or init.name in graph_outputs:
            copy = TensorProto()
            copy.CopyFrom(init)
            keep.append(copy)
    dropped = {i.name for i in graph.initializer} - {i.name for i in keep}
    del graph.initializer[:]
    graph.initializer.extend(keep)
    graph.initializer.extend(new_weights.values())
    stale_inputs = [v for v in graph.input if v.name in dropped]
    for v in stale_inputs:
        graph.input.remove(v)

    # value_info of tensors that no longer exist.
    alive = {v.name for v in graph.input} | {i.name for i in graph.initializer} | {o for n in nodes for o in n.output}
    stale = [v for v in graph.value_info if v.name not in alive]
    for v in stale:
        graph.value_info.remove(v)

    if model.ir_version != ir_version or [(o.domain, o.version) for o in model.opset_import] != opsets:
        raise SystemExit("dequantize: ir_version or opset changed, nothing written")
    onnx.checker.check_model(model)
    onnx.save(model, dst)

    after = count_ops(model)
    print(f"dequantize: {len(plans)} MatMulInteger -> MatMul with float weights ({len(new_weights)} distinct weight tensors)")
    print(f"  removed: {before.get('DynamicQuantizeLinear', 0)} DynamicQuantizeLinear, {len(dropped)} int8 initializers/scales")
    print(f"  before: {format_counts(before)}")
    print(f"  after:  {format_counts(after)}")
    print(f"  ir_version {model.ir_version}, opsets {opsets} (unchanged), {os.path.getsize(dst)} bytes -> {dst}")


def match(graph, mmi, index, label, inits, producers, consumers, graph_outputs):
    """Check the dynamic-quantization pattern around one MatMulInteger; returns node indices and tensor names."""
    if len(mmi.input) != 4 or not all(mmi.input):
        raise PatternError(f"expected 4 inputs (a, b, a_zero_point, b_zero_point), got {list(mmi.input)}")
    dql_index = producers.get(mmi.input[0])
    if dql_index is None or graph.node[dql_index].op_type != "DynamicQuantizeLinear":
        raise PatternError("input a is not produced by DynamicQuantizeLinear")
    dql = graph.node[dql_index]
    if mmi.input[0] != dql.output[0] or mmi.input[2] != dql.output[2]:
        raise PatternError("input a / a_zero_point are not the DynamicQuantizeLinear outputs y / y_zero_point")

    weight = inits.get(mmi.input[1])
    if weight is None or weight.data_type not in WEIGHT_TYPES or len(weight.dims) != 2:
        raise PatternError("input b is not a rank-2 int8/uint8 initializer")
    n = weight.dims[1]
    zp = inits.get(mmi.input[3])
    if zp is None or zp.data_type != weight.data_type or not shape_ok(zp.dims, n):
        raise PatternError("b_zero_point is not a scalar or per-column initializer of the weight's type")

    cast_users = consumers.get(mmi.output[0], [])
    if mmi.output[0] in graph_outputs or len(cast_users) != 1 or graph.node[cast_users[0]].op_type != "Cast":
        raise PatternError("output is not consumed by exactly one Cast")
    cast = graph.node[cast_users[0]]
    if not any(a.name == "to" and a.i == TensorProto.FLOAT for a in cast.attribute):
        raise PatternError("Cast does not go to float32")
    mul_users = consumers.get(cast.output[0], [])
    if cast.output[0] in graph_outputs or len(mul_users) != 1 or graph.node[mul_users[0]].op_type != "Mul":
        raise PatternError("Cast is not consumed by exactly one Mul")
    out_mul_index = mul_users[0]
    out_mul = graph.node[out_mul_index]
    others = [i for i in out_mul.input if i != cast.output[0]]
    if len(others) != 1:
        raise PatternError("scale Mul does not have exactly one other input")
    scales_index = producers.get(others[0])
    if scales_index is None or graph.node[scales_index].op_type != "Mul":
        raise PatternError("scale is not produced by a Mul (x_scale * w_scale)")
    scales = graph.node[scales_index]
    if len(scales.input) != 2 or dql.output[1] not in scales.input:
        raise PatternError("scale Mul does not take the DynamicQuantizeLinear y_scale and one other input")
    w_scale_names = [i for i in scales.input if i != dql.output[1]]
    if len(w_scale_names) != 1 or w_scale_names[0] not in inits:
        raise PatternError("weight scale is not an initializer")
    w_scale = inits[w_scale_names[0]]
    if w_scale.data_type != TensorProto.FLOAT or not shape_ok(w_scale.dims, n):
        raise PatternError("weight scale is not a float scalar or per-column initializer")
    return {
        "mmi": index,
        "dql": dql_index,
        "cast": cast_users[0],
        "out_mul": out_mul_index,
        "scales_mul": scales_index,
        "activation": dql.input[0],
        "weight": mmi.input[1],
        "w_zp": mmi.input[3],
        "w_scale": w_scale_names[0],
    }


def dynamic(src, dst, per_channel, weight_type):
    from onnxruntime.quantization import QuantType, quantize_dynamic

    if os.path.abspath(src) == os.path.abspath(dst):
        raise SystemExit("refusing to overwrite the input model")
    source = onnx.load(src, load_external_data=False)
    ir_version = source.ir_version
    opsets = [(o.domain, o.version) for o in source.opset_import]
    quantize_dynamic(
        src,
        dst,
        op_types_to_quantize=["MatMul"],
        per_channel=per_channel,
        weight_type=QuantType.QInt8 if weight_type == "qint8" else QuantType.QUInt8,
    )
    out = onnx.load(dst)
    out_opsets = [(o.domain, o.version) for o in out.opset_import]
    counts = count_ops(out)
    print(f"dynamic: per_channel={per_channel} weight_type={weight_type} -> {dst} ({os.path.getsize(dst)} bytes)")
    print(f"  ops: {format_counts(counts)}")
    print(f"  ir_version {ir_version} -> {out.ir_version}, opsets {opsets} -> {out_opsets}")
    if out.ir_version != ir_version or out_opsets != opsets:
        print("  WARNING: ir_version/opset differ from the source; check that onnxruntime-web 1.24.2 can still load it")
    if counts.get("ConvInteger", 0):
        raise SystemExit("dynamic: ConvInteger nodes appeared; the Conv nodes must stay float")


def initial_states(session):
    states = {}
    for inp in session.get_inputs():
        if inp.name == "x":
            continue
        shape = [d if isinstance(d, int) else 1 for d in inp.shape]
        dtype = np.int64 if inp.type == "tensor(int64)" else np.float32
        states[inp.name] = np.zeros(shape, dtype=dtype)
    return states


def smoke(path_a, path_b, steps, seed):
    import onnxruntime as ort

    sessions = [ort.InferenceSession(p, providers=["CPUExecutionProvider"]) for p in (path_a, path_b)]
    x_shape = None
    for inp in sessions[0].get_inputs():
        if inp.name == "x":
            x_shape = [d if isinstance(d, int) else 1 for d in inp.shape]
    if x_shape is None:
        raise SystemExit("smoke: model has no input named x")
    states = [initial_states(s) for s in sessions]
    for s, st in zip(sessions, states):
        names = {o.name for o in s.get_outputs()}
        missing = [k for k in st if f"new_{k}" not in names]
        if missing:
            raise SystemExit(f"smoke: no new_* output for state input(s) {missing[:5]}")
    rng = np.random.default_rng(seed)
    diffs, agree, blank_a, total = [], 0, 0, 0
    max_abs = 0.0
    ok = True
    for step in range(steps):
        x = rng.standard_normal(x_shape).astype(np.float32)
        logs = []
        for s, st in zip(sessions, states):
            names = [o.name for o in s.get_outputs()]
            result = dict(zip(names, s.run(None, {"x": x, **st})))
            for k in st:
                st[k] = result[f"new_{k}"]
            logs.append(result["log_probs"])
        a, b = logs
        if a.shape != b.shape or a.ndim != 3 or a.shape[-1] != 251:
            print(f"step {step}: unexpected shapes {a.shape} vs {b.shape}")
            ok = False
            break
        if not (np.isfinite(a).all() and np.isfinite(b).all()):
            print(f"step {step}: NaN or inf in log_probs")
            ok = False
            break
        d = np.abs(a.astype(np.float64) - b.astype(np.float64))
        diffs.append(d.mean())
        max_abs = max(max_abs, float(d.max()))
        agree += int((a.argmax(-1) == b.argmax(-1)).sum())
        blank_a += int((a.argmax(-1) == BLANK_ID).sum())
        total += a.argmax(-1).size
    if not diffs:
        print("smoke: FAILED (no steps completed)")
        return 1
    mean_abs = float(np.mean(diffs))
    print(f"smoke: {len(diffs)} steps, log_probs shape {tuple(logs[0].shape)}, inputs x {x_shape}")
    print(f"  mean abs log-prob diff: {mean_abs:.4f}  (limit {MEAN_ABS_LIMIT}), first step {diffs[0]:.4f}, last step {diffs[-1]:.4f}")
    print(f"  max abs diff: {max_abs:.4f}")
    print(f"  argmax agreement: {agree}/{total} = {agree / total:.3f}  (blank is the argmax in {blank_a}/{total} frames of model A)")
    passed = ok and len(diffs) == steps and mean_abs < MEAN_ABS_LIMIT
    print("smoke: PASSED" if passed else "smoke: FAILED")
    return 0 if passed else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p_deq = sub.add_parser("dequantize")
    p_deq.add_argument("input")
    p_deq.add_argument("output")
    p_dyn = sub.add_parser("dynamic")
    p_dyn.add_argument("input")
    p_dyn.add_argument("output")
    group = p_dyn.add_mutually_exclusive_group()
    group.add_argument("--per-tensor", action="store_true", help="default")
    group.add_argument("--per-channel", action="store_true")
    p_dyn.add_argument("--weight-type", choices=("qint8", "quint8"), default="qint8")
    p_smoke = sub.add_parser("smoke")
    p_smoke.add_argument("a")
    p_smoke.add_argument("b")
    p_smoke.add_argument("--steps", type=int, default=50)
    p_smoke.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()

    if args.command == "dequantize":
        dequantize(args.input, args.output)
    elif args.command == "dynamic":
        dynamic(args.input, args.output, per_channel=args.per_channel, weight_type=args.weight_type)
    else:
        return smoke(args.a, args.b, args.steps, args.seed)
    return 0


if __name__ == "__main__":
    sys.exit(main())
