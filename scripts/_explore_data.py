"""Explore FAFB 783 data structure: meta, edgelist, and neurotransmitter annotations."""
import pandas as pd
import os
import zipfile
import json

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_connectome_data")

print("=" * 70)
print("FAFB 783 META")
print("=" * 70)
meta = pd.read_feather(os.path.join(DATA_DIR, "fafb_783_meta.feather"))
print(f"Shape: {meta.shape}")
print(f"Columns: {list(meta.columns)}")
print(f"\nFirst 5 rows:")
print(meta.head().to_string())
print(f"\nDtypes:")
print(meta.dtypes)

# Look for cell type / neuropil columns
print(f"\n--- Unique values in key columns ---")
for col in meta.columns:
    nunique = meta[col].nunique()
    if nunique < 200 and meta[col].dtype == object:
        print(f"\n{col} ({nunique} unique):")
        vc = meta[col].value_counts().head(30)
        for val, cnt in vc.items():
            print(f"  {val}: {cnt}")

print("\n" + "=" * 70)
print("FAFB 783 SIMPLE EDGELIST")
print("=" * 70)
edges = pd.read_feather(os.path.join(DATA_DIR, "fafb_783_simple_edgelist.feather"))
print(f"Shape: {edges.shape}")
print(f"Columns: {list(edges.columns)}")
print(f"\nFirst 10 rows:")
print(edges.head(10).to_string())
print(f"\nDtypes:")
print(edges.dtypes)
print(f"\nEdge weight stats:")
if 'weight' in edges.columns:
    print(edges['weight'].describe())
elif 'count' in edges.columns:
    print(edges['count'].describe())

print("\n" + "=" * 70)
print("NEUROTRANSMITTER DATABASE (Zenodo)")
print("=" * 70)
nt_zip = os.path.join(DATA_DIR, "drosophila_neurotransmitters-v1.1.0.zip")
if os.path.exists(nt_zip):
    with zipfile.ZipFile(nt_zip, 'r') as z:
        names = z.namelist()
        print(f"Files in zip ({len(names)}):")
        for n in names[:30]:
            info = z.getinfo(n)
            print(f"  {n} ({info.file_size/1e6:.2f}MB)")
        # Read the first CSV/feather file
        for n in names:
            if n.endswith('.csv') or n.endswith('.feather') or n.endswith('.tsv'):
                print(f"\n--- Reading {n} ---")
                with z.open(n) as f:
                    if n.endswith('.csv'):
                        df = pd.read_csv(f, nrows=20)
                    elif n.endswith('.tsv'):
                        df = pd.read_csv(f, sep='\t', nrows=20)
                    else:
                        df = pd.read_feather(f)
                        df = df.head(20)
                    print(f"Shape: {df.shape}")
                    print(f"Columns: {list(df.columns)}")
                    print(df.head(10).to_string())
                break
