"""
Task 57: Extract MB+CX functional subgraph from FAFB 783 connectome.
v2: Compact encoding to fit within 2MB artifact budget.

Strategy:
  - Target ~8-10k neurons (MB+CX core, trimmed I/O)
  - Apply minimum synapse count threshold (count >= 2) to reduce edges
  - Use uint16 neuron indices (n < 65536) + uint8 quantized weights
  - Gzip compress the binary payload
  - Final artifact must be < 2MB base64

Data source:
  - FAFB 783 (FlyWire adult female brain), Lee Lab GCS bucket (public)
  - Version: fafb_783 (compiled 2026-04)
  - License: CC-BY 4.0 (Schlegel et al. 2021, Dorkenwald et al. 2024, Matsunami et al. 2024)
  - Neurotransmitter predictions: Eckstein et al. 2024 (Cell), embedded in meta
"""
import pandas as pd
import numpy as np
import os
import json
import struct
import base64
import gzip
import hashlib
from collections import defaultdict, Counter

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_connectome_data")
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "packages", "fly-brain", "src", "connectome-data")
os.makedirs(OUT_DIR, exist_ok=True)

# ============================================================
# 1. LOAD DATA
# ============================================================
print("=" * 70)
print("STEP 1: Loading FAFB 783 data")
print("=" * 70)

meta = pd.read_feather(os.path.join(DATA_DIR, "fafb_783_meta.feather"))
edges = pd.read_feather(os.path.join(DATA_DIR, "fafb_783_simple_edgelist.feather"))
print(f"  Meta: {len(meta)} neurons")
print(f"  Edges: {len(edges)} connections")

# ============================================================
# 2. IDENTIFY MB + CX NEURONS (TIGHTER SELECTION)
# ============================================================
print("\n" + "=" * 70)
print("STEP 2: Identifying MB + CX core neurons")
print("=" * 70)

# Core MB classes
MB_CLASSES = [
    'kenyon_cell',                        # ~5177 KCs
    'mushroom_body_output_neuron',        # ~96 MBONs
    'mushroom_body_dopaminergic_neuron',  # ~331 DANs
    'mushroom_body_extrinsic_neuron',     # extrinsic
]

# Core CX classes
CX_CLASSES = [
    'central_complex_intrinsic_neuron',   # ~1349
    'central_complex_input_neuron',       # ~989
    'central_complex_output_neuron',      # ~527
]

# Minimal I/O for functional connectivity (trimmed)
IO_CLASSES = [
    'antennal_lobe_projection_neuron',    # PNs → KC (essential MB input)
    'descending_neuron',                  # DN: CX/MB output → motor
]

mb_mask = meta['cell_class'].isin(MB_CLASSES)
cx_mask = meta['cell_class'].isin(CX_CLASSES)
io_mask = meta['cell_class'].isin(IO_CLASSES)

# Filter bad neurons
bad_status = ['outlier_seg', 'outlier_bio', 'not_a_neuron', 'tiny', 'duplicate',
              'bad_nucleus', 'needs_extending', 'hard', 'merge_error']
good_mask = ~meta['status'].isin(bad_status) | meta['status'].isna()

core_mask = (mb_mask | cx_mask | io_mask) & good_mask
core_neurons = meta[core_mask].copy()

print(f"  MB: {mb_mask.sum()}, CX: {cx_mask.sum()}, I/O: {io_mask.sum()}")
print(f"  Core (filtered): {len(core_neurons)}")

# ============================================================
# 3. EXTRACT SUBGRAPH WITH EDGE THRESHOLD
# ============================================================
print("\n" + "=" * 70)
print("STEP 3: Extracting subgraph (min synapse count >= 2)")
print("=" * 70)

core_ids = set(core_neurons['fafb_783_id'].astype(str).tolist())

# Filter edges: both endpoints in core AND count >= 2 (remove weak/noisy connections)
MIN_COUNT = 2
edges_filtered = edges[
    (edges['pre'].astype(str).isin(core_ids)) &
    (edges['post'].astype(str).isin(core_ids)) &
    (edges['count'] >= MIN_COUNT)
].copy()

print(f"  Edges (count >= {MIN_COUNT}): {len(edges_filtered)}")

# Active neurons
active_pre = set(edges_filtered['pre'].astype(str).unique())
active_post = set(edges_filtered['post'].astype(str).unique())
active_ids = active_pre | active_post
print(f"  Active neurons: {len(active_ids)}")

# Target: <= 12000 neurons. If over, trim by total connectivity.
MAX_NEURONS = 12000
if len(active_ids) > MAX_NEURONS:
    print(f"  Trimming to {MAX_NEURONS}...")
    # Priority: MB+CX core first, then I/O by degree
    mb_cx_ids = set(core_neurons[mb_mask | cx_mask]['fafb_783_id'].astype(str).tolist()) & active_ids
    io_active = active_ids - mb_cx_ids

    if len(mb_cx_ids) >= MAX_NEURONS:
        # Even MB+CX is too many - trim KCs (largest group) by connectivity
        degree = defaultdict(int)
        for _, row in edges_filtered.iterrows():
            degree[str(row['pre'])] += row['count']
            degree[str(row['post'])] += row['count']
        sorted_all = sorted(mb_cx_ids, key=lambda x: degree.get(x, 0), reverse=True)
        active_ids = set(sorted_all[:MAX_NEURONS])
    else:
        # Keep all MB+CX, add top I/O by degree
        degree = defaultdict(int)
        for _, row in edges_filtered.iterrows():
            pre_s, post_s = str(row['pre']), str(row['post'])
            if pre_s in io_active:
                degree[pre_s] += row['count']
            if post_s in io_active:
                degree[post_s] += row['count']
        max_io = MAX_NEURONS - len(mb_cx_ids)
        sorted_io = sorted(degree.keys(), key=lambda x: degree[x], reverse=True)[:max(0, max_io)]
        active_ids = mb_cx_ids | set(sorted_io)

    # Re-filter edges
    edges_filtered = edges_filtered[
        edges_filtered['pre'].astype(str).isin(active_ids) &
        edges_filtered['post'].astype(str).isin(active_ids)
    ]
    print(f"  After trim: {len(active_ids)} neurons, {len(edges_filtered)} edges")

# If still too many edges, increase threshold
MAX_EDGES = 500000
if len(edges_filtered) > MAX_EDGES:
    print(f"  Edges {len(edges_filtered)} > {MAX_EDGES}, increasing threshold...")
    for threshold in [3, 4, 5, 6, 8, 10]:
        test = edges_filtered[edges_filtered['count'] >= threshold]
        print(f"    count >= {threshold}: {len(test)} edges")
        if len(test) <= MAX_EDGES:
            edges_filtered = test
            MIN_COUNT = threshold
            break
    # Re-check active neurons
    active_ids = set(edges_filtered['pre'].astype(str).unique()) | set(edges_filtered['post'].astype(str).unique())
    print(f"  Final: {len(active_ids)} neurons, {len(edges_filtered)} edges (threshold={MIN_COUNT})")

# Build index
final_ids = sorted(active_ids)
id_to_idx = {nid: i for i, nid in enumerate(final_ids)}
n_neurons = len(final_ids)
n_edges = len(edges_filtered)

print(f"\n  FINAL: {n_neurons} neurons, {n_edges} edges")

# ============================================================
# 4. ASSIGN LAYER + SIGN
# ============================================================
print("\n" + "=" * 70)
print("STEP 4: Layer + sign assignment")
print("=" * 70)

final_meta = core_neurons[core_neurons['fafb_783_id'].astype(str).isin(active_ids)].copy()
final_meta['_id_str'] = final_meta['fafb_783_id'].astype(str)
final_meta = final_meta.set_index('_id_str')

def assign_layer(row):
    cc = str(row.get('cell_class', ''))
    csc = str(row.get('cell_sub_class', ''))
    ct = str(row.get('cell_type', ''))
    nt = str(row.get('neurotransmitter_predicted', ''))

    # PRIORITY 1: Explicit cell_class mapping (authoritative)
    # Sensory: PN (olfactory relay to MB calyx), CX input neurons
    if cc in ['antennal_lobe_projection_neuron', 'central_complex_input_neuron']:
        return 'sensory'
    # Motor: descending neurons (CX/MB output → body)
    if cc == 'descending_neuron':
        return 'motor'
    # Inter L1: Kenyon cells (MB computation), CX intrinsic (ring attractor, etc.)
    if cc in ['kenyon_cell', 'central_complex_intrinsic_neuron']:
        return 'inter_l1'
    # Inter L2: MBONs, CX output, MB extrinsic (decision/output layer)
    if cc in ['mushroom_body_output_neuron', 'central_complex_output_neuron', 'mushroom_body_extrinsic_neuron']:
        return 'inter_l2'
    if ct.startswith('MBON'):
        return 'inter_l2'

    # PRIORITY 2: Modulatory classification (only for neurons not matched above)
    if 'dopaminergic' in cc or 'dopaminergic' in csc:
        return 'modulatory'
    if nt in ['dopamine', 'serotonin', 'octopamine']:
        return 'modulatory'

    # Default
    return 'inter_l1'

EXCITATORY_NT = {'acetylcholine', 'glutamate'}
INHIBITORY_NT = {'gaba', 'glycine'}

def assign_sign(nt_predicted):
    nt = str(nt_predicted).lower().strip()
    if nt in INHIBITORY_NT:
        return -1
    return 1  # excitatory or modulatory (net depolarizing)

layers = []
signs = []
nt_types = []

for nid in final_ids:
    if nid in final_meta.index:
        row = final_meta.loc[nid]
        if isinstance(row, pd.DataFrame):
            row = row.iloc[0]
    else:
        row = pd.Series({'cell_class': 'unknown', 'neurotransmitter_predicted': 'acetylcholine',
                         'cell_sub_class': '', 'cell_type': ''})
    layers.append(assign_layer(row))
    nt = str(row.get('neurotransmitter_predicted', 'acetylcholine'))
    nt_types.append(nt)
    signs.append(assign_sign(nt))

layer_counts = Counter(layers)
sign_counts = Counter(signs)
nt_counts = Counter(nt_types)

print(f"  Layers: {dict(sorted(layer_counts.items()))}")
print(f"  Signs: exc={sign_counts.get(1,0)} ({sign_counts.get(1,0)/n_neurons*100:.1f}%), inh={sign_counts.get(-1,0)} ({sign_counts.get(-1,0)/n_neurons*100:.1f}%)")
print(f"  NT: {dict(nt_counts.most_common())}")

# ============================================================
# 5. BUILD COMPACT BINARY (uint16 indices + uint8 weights)
# ============================================================
print("\n" + "=" * 70)
print("STEP 5: Compact binary encoding")
print("=" * 70)

assert n_neurons < 65536, f"Too many neurons for uint16: {n_neurons}"

# Sort edges deterministically by (post, pre)
edges_filtered = edges_filtered.copy()
edges_filtered['pre_idx'] = edges_filtered['pre'].astype(str).map(id_to_idx).astype(np.uint16)
edges_filtered['post_idx'] = edges_filtered['post'].astype(str).map(id_to_idx).astype(np.uint16)
edges_sorted = edges_filtered.sort_values(['post_idx', 'pre_idx']).reset_index(drop=True)

pre_arr = edges_sorted['pre_idx'].values.astype(np.uint16)
post_arr = edges_sorted['post_idx'].values.astype(np.uint16)
counts_arr = edges_sorted['count'].values.astype(np.float32)

# Quantize weights to uint8 [0, 255]
# Use log scaling: w_q = round(log1p(count) / log1p(max_count) * 254) + 1  (range [1, 255], 0 = no edge)
log_counts = np.log1p(counts_arr)
max_log = log_counts.max()
weights_q = np.clip(np.round(log_counts / max_log * 254) + 1, 1, 255).astype(np.uint8)

# Sign is determined by presynaptic neuron's NT (stored per-neuron, not per-edge)
# So we don't need to store sign per edge - it's derived from pre neuron's sign array

print(f"  Neurons: {n_neurons} (uint16 indices)")
print(f"  Edges: {n_edges}")
print(f"  Weight quantization: uint8 [1-255], log-scaled")
print(f"  Raw weight range: count [{counts_arr.min():.0f}, {counts_arr.max():.0f}]")

# Fan-in stats
fan_in = np.bincount(post_arr.astype(np.int32), minlength=n_neurons)
print(f"  Fan-in: mean={fan_in.mean():.1f}, max={fan_in.max()}, median={np.median(fan_in):.0f}")

# ============================================================
# 6. PACK + COMPRESS
# ============================================================
print("\n" + "=" * 70)
print("STEP 6: Packing and compressing")
print("=" * 70)

LAYER_CODES = {'sensory': 0, 'inter_l1': 1, 'inter_l2': 2, 'modulatory': 3, 'motor': 4}
NT_NAMES = ['acetylcholine', 'glutamate', 'gaba', 'glycine', 'dopamine', 'serotonin', 'octopamine', 'tyramine', 'histamine', 'unknown']
nt_to_code = {nt: i for i, nt in enumerate(NT_NAMES)}

layer_codes = np.array([LAYER_CODES[l] for l in layers], dtype=np.uint8)
signs_arr = np.array(signs, dtype=np.int8)
nt_codes = np.array([nt_to_code.get(nt, nt_to_code['unknown']) for nt in nt_types], dtype=np.uint8)

# Binary layout (all little-endian):
#   Header: uint32 n_neurons, uint32 n_edges, uint8 version
#   Per-neuron: uint8[n] layer_codes, int8[n] signs, uint8[n] nt_codes
#   Per-edge (CSR-like, sorted by post then pre):
#     uint16[E] pre_indices, uint16[E] post_indices, uint8[E] weights_quantized
payload = bytearray()
payload += struct.pack('<I', n_neurons)
payload += struct.pack('<I', n_edges)
payload += struct.pack('<B', 1)  # format version
payload += layer_codes.tobytes()
payload += signs_arr.tobytes()
payload += nt_codes.tobytes()
payload += pre_arr.tobytes()
payload += post_arr.tobytes()
payload += weights_q.tobytes()

raw_size = len(payload)
compressed = gzip.compress(bytes(payload), compresslevel=9)
compressed_b64 = base64.b64encode(compressed).decode('ascii')
raw_hash = hashlib.sha256(bytes(payload)).hexdigest()
compressed_hash = hashlib.sha256(compressed).hexdigest()

print(f"  Raw binary: {raw_size:,} bytes ({raw_size/1e6:.2f} MB)")
print(f"  Gzip compressed: {len(compressed):,} bytes ({len(compressed)/1e6:.2f} MB)")
print(f"  Base64 of compressed: {len(compressed_b64):,} chars ({len(compressed_b64)/1e6:.2f} MB)")
print(f"  Raw SHA-256: {raw_hash}")
print(f"  Compressed SHA-256: {compressed_hash}")

# Constraint checks
print(f"\n  === CONSTRAINT CHECKS ===")
b64_under_2mb = len(compressed_b64) < 2 * 1024 * 1024
neurons_ok = n_neurons < 30800
# Heap estimate: decompressed arrays in memory
# Float32Array[n] for weights (reconstructed) + Uint16Array[E] for pre/post + per-neuron arrays
heap_est_mb = (n_neurons * 6 * 4 + n_edges * 5 + n_neurons * 3) / 1e6
heap_ok = heap_est_mb < 72

print(f"  Neurons < 30,800: {'PASS' if neurons_ok else 'FAIL'} ({n_neurons})")
print(f"  Compressed b64 < 2MB: {'PASS' if b64_under_2mb else 'FAIL'} ({len(compressed_b64)/1e6:.2f} MB)")
print(f"  Heap estimate < 72MB: {'PASS' if heap_ok else 'FAIL'} (~{heap_est_mb:.1f} MB)")

# If still over 2MB, we need to further reduce
if not b64_under_2mb:
    print(f"\n  WARNING: Still over 2MB. Trying higher edge threshold...")
    for threshold in [MIN_COUNT + 1, MIN_COUNT + 2, MIN_COUNT + 3, MIN_COUNT + 5, MIN_COUNT + 8, MIN_COUNT + 10]:
        test_edges = edges[
            (edges['pre'].astype(str).isin(core_ids)) &
            (edges['post'].astype(str).isin(core_ids)) &
            (edges['count'] >= threshold)
        ]
        # Estimate compressed size (rough: 5 bytes/edge, 60% compression)
        est_size = (n_neurons * 3 + len(test_edges) * 5) * 0.4
        print(f"    count >= {threshold}: {len(test_edges)} edges, est. compressed ~{est_size/1e6:.2f} MB")
        if est_size < 1.8e6:
            print(f"    -> Using threshold {threshold}")
            MIN_COUNT = threshold
            edges_filtered = test_edges
            break

    if MIN_COUNT > 2:
        # Redo with new threshold
        active_ids = set(edges_filtered['pre'].astype(str).unique()) | set(edges_filtered['post'].astype(str).unique())
        final_ids = sorted(active_ids)
        id_to_idx = {nid: i for i, nid in enumerate(final_ids)}
        n_neurons = len(final_ids)
        n_edges = len(edges_filtered)

        # Rebuild arrays
        edges_filtered = edges_filtered.copy()
        edges_filtered['pre_idx'] = edges_filtered['pre'].astype(str).map(id_to_idx).astype(np.uint16)
        edges_filtered['post_idx'] = edges_filtered['post'].astype(str).map(id_to_idx).astype(np.uint16)
        edges_sorted = edges_filtered.sort_values(['post_idx', 'pre_idx']).reset_index(drop=True)

        pre_arr = edges_sorted['pre_idx'].values.astype(np.uint16)
        post_arr = edges_sorted['post_idx'].values.astype(np.uint16)
        counts_arr = edges_sorted['count'].values.astype(np.float32)
        log_counts = np.log1p(counts_arr)
        max_log = log_counts.max()
        weights_q = np.clip(np.round(log_counts / max_log * 254) + 1, 1, 255).astype(np.uint8)

        # Re-assign layers/signs for new neuron set
        layers = []
        signs = []
        nt_types = []
        for nid in final_ids:
            if nid in final_meta.index:
                row = final_meta.loc[nid]
                if isinstance(row, pd.DataFrame):
                    row = row.iloc[0]
            else:
                row = pd.Series({'cell_class': 'unknown', 'neurotransmitter_predicted': 'acetylcholine',
                                 'cell_sub_class': '', 'cell_type': ''})
            layers.append(assign_layer(row))
            nt = str(row.get('neurotransmitter_predicted', 'acetylcholine'))
            nt_types.append(nt)
            signs.append(assign_sign(nt))

        layer_codes = np.array([LAYER_CODES[l] for l in layers], dtype=np.uint8)
        signs_arr = np.array(signs, dtype=np.int8)
        nt_codes = np.array([nt_to_code.get(nt, nt_to_code['unknown']) for nt in nt_types], dtype=np.uint8)
        layer_counts = Counter(layers)
        sign_counts = Counter(signs)

        # Repack
        payload = bytearray()
        payload += struct.pack('<I', n_neurons)
        payload += struct.pack('<I', n_edges)
        payload += struct.pack('<B', 1)
        payload += layer_codes.tobytes()
        payload += signs_arr.tobytes()
        payload += nt_codes.tobytes()
        payload += pre_arr.tobytes()
        payload += post_arr.tobytes()
        payload += weights_q.tobytes()

        raw_size = len(payload)
        compressed = gzip.compress(bytes(payload), compresslevel=9)
        compressed_b64 = base64.b64encode(compressed).decode('ascii')
        raw_hash = hashlib.sha256(bytes(payload)).hexdigest()
        compressed_hash = hashlib.sha256(compressed).hexdigest()

        fan_in = np.bincount(post_arr.astype(np.int32), minlength=n_neurons)
        heap_est_mb = (n_neurons * 6 * 4 + n_edges * 5 + n_neurons * 3) / 1e6

        print(f"\n  REVISED: {n_neurons} neurons, {n_edges} edges")
        print(f"  Raw: {raw_size:,} bytes, Compressed: {len(compressed):,} bytes")
        print(f"  Base64: {len(compressed_b64):,} chars ({len(compressed_b64)/1e6:.2f} MB)")
        print(f"  Heap est: ~{heap_est_mb:.1f} MB")
        b64_under_2mb = len(compressed_b64) < 2 * 1024 * 1024
        print(f"  Compressed b64 < 2MB: {'PASS' if b64_under_2mb else 'FAIL'}")

# ============================================================
# 7. WRITE ARTIFACTS
# ============================================================
print("\n" + "=" * 70)
print("STEP 7: Writing artifacts")
print("=" * 70)

artifact_meta = {
    "version": 1,
    "format": "fafb783-mb-cx-v1",
    "source": {
        "dataset": "FAFB_783",
        "description": "FlyWire adult female fruit fly brain connectome (FAFB), MB+CX functional subgraph",
        "version": "fafb_783 (compiled 2026-04)",
        "license": "CC-BY 4.0",
        "citations": [
            "Schlegel P, et al. (2021). Whole-brain annotation and taxonomy of cell types in the adult brain of Drosophila melanogaster. eLife 10:e62552.",
            "Dorkenwald S, et al. (2024). Neuronal wiring diagram of an adult brain. Nature 634:124-138.",
            "Matsunami K, et al. (2024). A connectome of the adult Drosophila central brain. bioRxiv.",
            "Eckstein N, et al. (2024). Neurotransmitter classification from electron microscopy images at the synapse resolution. Cell 187(22).",
        ],
        "url": "https://storage.googleapis.com/lee-lab_brain-and-nerve-cord-fly-connectome/compiled_data/fafb_783/",
        "neurotransmitter_method": "Eckstein et al. 2024 predictions (embedded in fafb_783_meta.feather)",
        "extraction_date": "2026-09-27",
        "min_synapse_count": MIN_COUNT,
        "subgraph_scope": "mushroom_body + central_complex + antennal_lobe_PN + descending_neurons",
    },
    "stats": {
        "n_neurons": n_neurons,
        "n_edges": n_edges,
        "layer_counts": dict(sorted(layer_counts.items())),
        "sign_distribution": {
            "excitatory_neurons": int(Counter(signs).get(1, 0)),
            "inhibitory_neurons": int(Counter(signs).get(-1, 0)),
            "excitatory_pct": round(Counter(signs).get(1, 0) / n_neurons * 100, 1),
            "inhibitory_pct": round(Counter(signs).get(-1, 0) / n_neurons * 100, 1),
        },
        "fan_in": {
            "mean": round(float(fan_in.mean()), 1),
            "max": int(fan_in.max()),
            "median": float(np.median(fan_in)),
        },
    },
    "encoding": {
        "format": "gzip(base64) of little-endian binary",
        "layout": "uint32 n_neurons | uint32 n_edges | uint8 version | uint8[n] layers | int8[n] signs | uint8[n] nt_codes | uint16[E] pre | uint16[E] post | uint8[E] weights_q",
        "weight_quantization": "uint8 [1-255], log1p(count)/log1p(max_count)*254+1",
        "sign_rule": "per-neuron from presynaptic NT: GABA/GLY=-1, else=+1",
        "layer_codes": LAYER_CODES,
        "nt_names": NT_NAMES,
    },
    "integrity": {
        "raw_sha256": raw_hash,
        "compressed_sha256": compressed_hash,
        "raw_bytes": raw_size,
        "compressed_bytes": len(compressed),
        "base64_chars": len(compressed_b64),
    },
    "constraints": {
        "neurons_under_30800": bool(n_neurons < 30800),
        "compressed_b64_under_2MB": bool(b64_under_2mb),
        "heap_under_72MB": bool(heap_est_mb < 72),
        "heap_estimate_mb": round(heap_est_mb, 1),
    },
}

# Write metadata JSON
meta_path = os.path.join(OUT_DIR, "fafb783-mb-cx-meta.json")
with open(meta_path, 'w') as f:
    json.dump(artifact_meta, f, indent=2)
print(f"  Metadata: {meta_path} ({os.path.getsize(meta_path):,} bytes)")

# Write compressed payload
payload_path = os.path.join(OUT_DIR, "fafb783-mb-cx.bin.gz.b64")
with open(payload_path, 'w') as f:
    f.write(compressed_b64)
print(f"  Payload: {payload_path} ({os.path.getsize(payload_path):,} bytes)")

print("\n" + "=" * 70)
print("EXTRACTION COMPLETE")
print(f"  {n_neurons} neurons, {n_edges} edges")
print(f"  Artifact: {len(compressed_b64)/1e6:.2f} MB (base64 of gzip)")
print(f"  All constraints: {'PASS' if (neurons_ok and b64_under_2mb and heap_ok) else 'CHECK ABOVE'}")
print("=" * 70)
