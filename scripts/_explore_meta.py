"""Explore FAFB 783 meta categorical columns to find MB and CX neurons."""
import pandas as pd
import os

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_connectome_data")
meta = pd.read_feather(os.path.join(DATA_DIR, "fafb_783_meta.feather"))

print(f"Total neurons: {len(meta)}")
print(f"\n{'='*70}")

# Check categorical columns
for col in ['region', 'side', 'flow', 'super_class', 'cell_class', 'cell_sub_class', 
            'neurotransmitter_predicted', 'cell_function', 'status']:
    nunique = meta[col].nunique()
    print(f"\n--- {col} ({nunique} unique) ---")
    vc = meta[col].value_counts()
    for val, cnt in vc.head(40).items():
        print(f"  {val}: {cnt}")
    if nunique > 40:
        print(f"  ... ({nunique - 40} more)")

# Search for mushroom body related
print(f"\n{'='*70}")
print("MUSHROOM BODY SEARCH")
print(f"{'='*70}")
mb_mask = meta.apply(lambda row: row.astype(str).str.contains('mushroom|kenyon|MB|calyx|lobe', case=False).any(), axis=1)
print(f"Neurons matching 'mushroom|kenyon|MB|calyx|lobe': {mb_mask.sum()}")
if mb_mask.sum() > 0:
    mb_neurons = meta[mb_mask]
    print(f"\nCell classes:")
    print(mb_neurons['cell_class'].value_counts().head(20))
    print(f"\nCell sub-classes:")
    print(mb_neurons['cell_sub_class'].value_counts().head(20))

# Search for central complex related
print(f"\n{'='*70}")
print("CENTRAL COMPLEX SEARCH")
print(f"{'='*70}")
cx_mask = meta.apply(lambda row: row.astype(str).str.contains('central_complex|fan.shaped|ellipsoid|protocerebral_bridge|nodul|CX|EB|FB|PB', case=False).any(), axis=1)
print(f"Neurons matching CX terms: {cx_mask.sum()}")
if cx_mask.sum() > 0:
    cx_neurons = meta[cx_mask]
    print(f"\nCell classes:")
    print(cx_neurons['cell_class'].value_counts().head(20))
    print(f"\nCell sub-classes:")
    print(cx_neurons['cell_sub_class'].value_counts().head(20))

# Also search by cell_class containing key terms
print(f"\n{'='*70}")
print("CELL_CLASS values containing key terms:")
print(f"{'='*70}")
for term in ['mushroom', 'kenyon', 'central_complex', 'fan', 'ellipsoid', 'bridge', 'nodul',
             'dopaminergic', 'projection_neuron', 'interneuron', 'motor', 'sensory']:
    matches = meta[meta['cell_class'].str.contains(term, case=False, na=False)]
    if len(matches) > 0:
        print(f"\n  '{term}' in cell_class: {len(matches)} neurons")
        print(f"    Types: {matches['cell_class'].unique()[:5]}")

# Search in cell_sub_class
print(f"\n{'='*70}")
print("CELL_SUB_CLASS values containing key terms:")
for term in ['mushroom', 'kenyon', 'central_complex', 'fan', 'ellipsoid', 'bridge', 'nodul',
             'dopaminergic', 'PAM', 'MBON', 'LHN', 'EPL', 'ring']:
    matches = meta[meta['cell_sub_class'].str.contains(term, case=False, na=False)]
    if len(matches) > 0:
        print(f"\n  '{term}' in cell_sub_class: {len(matches)} neurons")
        print(f"    Sub-classes: {matches['cell_sub_class'].unique()[:8]}")

# Search in cell_type
print(f"\n{'='*70}")
print("CELL_TYPE values containing key terms:")
for term in ['KC', 'MBON', 'DAN', 'PAM', 'EPL', 'ring', 'fan', 'bridge', 'nodul',
             'TL', 'CL1', 'TB', 'CPU', 'CPU1', 'CPU4', 'PEN', 'hDelta']:
    matches = meta[meta['cell_type'].str.contains(f'^{term}', case=True, na=False, regex=True)]
    if len(matches) > 0:
        print(f"\n  '{term}*' in cell_type: {len(matches)} neurons")
        print(f"    Types: {matches['cell_type'].unique()[:10]}")
