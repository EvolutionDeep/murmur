"""
Download FAFB 783 connectome data (meta + edgelist) and neurotransmitter annotations.
Data source: Lee Lab GCS bucket (public), Zenodo (CC-BY 4.0).
"""
import urllib.request
import os
import sys
import time

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_connectome_data")
os.makedirs(DATA_DIR, exist_ok=True)

GCS_BASE = "https://storage.googleapis.com/lee-lab_brain-and-nerve-cord-fly-connectome/compiled_data/fafb_783"

FILES = [
    # (url, local_filename, expected_size_bytes)
    (f"{GCS_BASE}/fafb_783_meta.feather", "fafb_783_meta.feather", 13_500_000),
    (f"{GCS_BASE}/fafb_783_simple_edgelist.feather", "fafb_783_simple_edgelist.feather", 302_600_000),
]

# Zenodo neurotransmitter database (Eckstein et al. 2024)
NT_URL = "https://zenodo.org/api/records/20818142/files/flyconnectome/drosophila_neurotransmitters-v1.1.0.zip/content"
NT_FILE = "drosophila_neurotransmitters-v1.1.0.zip"

def download(url, dest, expected_size=None, chunk_size=1024*1024):
    """Download with progress."""
    if os.path.exists(dest):
        size = os.path.getsize(dest)
        if expected_size and size >= expected_size * 0.9:
            print(f"  SKIP (exists, {size/1e6:.1f}MB): {os.path.basename(dest)}")
            return True
        elif not expected_size and size > 0:
            print(f"  SKIP (exists, {size/1e6:.1f}MB): {os.path.basename(dest)}")
            return True
    
    print(f"  DOWNLOADING: {os.path.basename(dest)} from {url[:80]}...")
    start = time.time()
    try:
        req = urllib.request.Request(url)
        req.add_header('User-Agent', 'Mozilla/5.0 (research-script)')
        r = urllib.request.urlopen(req, timeout=30)
        total = int(r.headers.get('Content-Length', 0))
        downloaded = 0
        with open(dest, 'wb') as f:
            while True:
                chunk = r.read(chunk_size)
                if not chunk:
                    break
                f.write(chunk)
                downloaded += len(chunk)
                if total > 0 and downloaded % (10*1024*1024) < chunk_size:
                    pct = downloaded / total * 100
                    elapsed = time.time() - start
                    speed = downloaded / elapsed / 1e6
                    print(f"    {pct:.0f}% ({downloaded/1e6:.1f}/{total/1e6:.1f}MB) {speed:.1f}MB/s")
        elapsed = time.time() - start
        print(f"  DONE: {downloaded/1e6:.1f}MB in {elapsed:.0f}s ({downloaded/elapsed/1e6:.1f}MB/s)")
        return True
    except Exception as e:
        print(f"  FAILED: {e}")
        if os.path.exists(dest):
            os.remove(dest)
        return False

if __name__ == "__main__":
    # Download meta first (small, essential)
    print("=== Step 1: Download neuron metadata ===")
    meta_ok = download(FILES[0][0], os.path.join(DATA_DIR, FILES[0][1]), FILES[0][2])
    
    # Download neurotransmitter annotations
    print("\n=== Step 2: Download neurotransmitter database (Zenodo, CC-BY 4.0) ===")
    nt_ok = download(NT_URL, os.path.join(DATA_DIR, NT_FILE), 11_400_000)
    
    # Download edge list (large)
    print("\n=== Step 3: Download simple edge list ===")
    edge_ok = download(FILES[1][0], os.path.join(DATA_DIR, FILES[1][1]), FILES[1][2])
    
    print(f"\n=== Summary ===")
    print(f"  Meta: {'OK' if meta_ok else 'FAILED'}")
    print(f"  Neurotransmitters: {'OK' if nt_ok else 'FAILED'}")
    print(f"  Edge list: {'OK' if edge_ok else 'FAILED'}")
    
    if not edge_ok:
        print("\n  Edge list download failed. Will try alternative approaches.")
        sys.exit(1)
