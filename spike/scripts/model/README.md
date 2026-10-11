# Model tools (Python)

Two offline tools for the speed experiments (see `.claude/PRPs/plans/speed-accuracy-experiments.plan.md`, Task 6).
They read the shipped model in `public/models/` and write derived models next to it. The shipped model and everything
derived from it are covered by NPL-1.2 (`spike/NOTICE.md`): outputs stay in `public/models/` (git-ignored), are never
committed, and nothing here touches the original file.

Nothing leaves the machine: no audio, no network use except `pip install` from PyPI.

## Setup

Use a venv **outside the repo**, and run Python with `-I` (isolated mode: no user site, no current directory on the path).

```bash
python -I -m venv <short-dir>/qv
<short-dir>/qv/Scripts/python.exe -I -m pip install "onnxruntime==1.24.*" onnx numpy   # Linux/macOS: bin/python
```

- `onnxruntime==1.24.*` matches the `onnxruntime-web` 1.24.x the app uses. Python 3.10 or newer.
- On Windows without long-path support, keep the venv path short (for example `%TEMP%\qv`): pip fails inside a deeply
  nested session scratch directory (`MAX_PATH`).
- Run the commands below from `spike/`.

## `inspect_model.py`

```bash
python -I scripts/model/inspect_model.py public/models/zipformer_p_arabic_v3_c16.int8.onnx
```

Prints from the graph (op types, not text matches): op-type counts; for every `MatMulInteger` the weight type
(QInt8/QUInt8), the `b_zero_point` shape and the weight scale found by following `Cast` -> `Mul` (x_scale * w_scale),
which gives **per-tensor or per-channel**; input dims (`x` -> T, `cached_key_0` -> left context); output names; and the op counts
after onnxruntime's own optimizer (CPU EP, `ORT_ENABLE_ALL`), which shows whether `DynamicQuantizeMatMul` /
`MatMulIntegerToFloat` fusions happen. The CPU optimizer is close to, but not identical to, the WASM build's: indicative only.
The optimized graph goes to a temporary directory; `--optimized-path <file>` keeps it (put it outside the repo),
`--no-optimized` skips it.

## `requantize.py`

```bash
# int8 -> float graph (speed question: is float faster than dynamic int8 here?)
python -I scripts/model/requantize.py dequantize public/models/zipformer_p_arabic_v3_c16.int8.onnx public/models/zipformer_p_arabic_v3_c16.deq-fp32.onnx

# smoke test: 50 consecutive random steps, cache states carried
python -I scripts/model/requantize.py smoke public/models/zipformer_p_arabic_v3_c16.int8.onnx public/models/zipformer_p_arabic_v3_c16.deq-fp32.onnx

# float -> per-tensor dynamic int8 (MatMul only; Conv stays float). Only needed if the shipped model is per-channel.
python -I scripts/model/requantize.py dynamic <in.onnx> public/models/zipformer_p_arabic_v3_c16.deq-pt-int8.onnx --per-tensor --weight-type qint8
```

- `dequantize` replaces every `DynamicQuantizeLinear` + `MatMulInteger` (+ `Cast` and the scale `Mul`) with a float `MatMul`
  whose weight is `(W_int8 - zero_point) * scale`. One `DynamicQuantizeLinear` can feed several `MatMulInteger`; it is removed
  only when none is left. The float activation x activation `MatMul` nodes and the `Conv` nodes are untouched. The source
  `ir_version` and opset are kept. The int8 weights are rounded, so the result is **not** the official fp32 model (that
  comes with the gated files in Phase B): it answers the speed question, and its accuracy is judged by the bench on real
  recordings.
- If a node does not match the expected pattern, the tool lists the node names and writes nothing.
- `smoke` passes when the shapes match, nothing is NaN and the mean abs log-prob difference is below 0.5. The argmax agreement and
  the max abs difference are printed, not gated (on random input the argmax is mostly blank).
- `dynamic` uses `op_types_to_quantize=["MatMul"]` and the weight type that `inspect_model.py` prints for the shipped model;
  quantize_dynamic's defaults would also turn the `Conv` nodes into `ConvInteger`. After writing, compare its op-type counts with
  `inspect_model.py` on the shipped file: only if they are identical is the result "per-tensor vs per-channel only".
- Load a derived model in the bench with `?model=<file name>` (bench only).
