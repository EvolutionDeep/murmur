"""Find FAFB/hemibrain data in accessible sources."""
import urllib.request
import json
import xml.etree.ElementTree as ET

def list_gcs(bucket, prefix, max_keys=50, marker=None):
    """List GCS bucket contents."""
    url = f"https://storage.googleapis.com/{bucket}?prefix={prefix}&max-keys={max_keys}"
    if marker:
        url += f"&marker={marker}"
    r = urllib.request.urlopen(url, timeout=15)
    content = r.read().decode('utf-8')
    root = ET.fromstring(content)
    ns = {'s3': 'http://doc.s3.amazonaws.com/2006-03-01'}
    items = []
    for c in root.findall('.//{http://doc.s3.amazonaws.com/2006-03-01}Contents'):
        key = c.find('{http://doc.s3.amazonaws.com/2006-03-01}Key').text
        size = c.find('{http://doc.s3.amazonaws.com/2006-03-01}Size').text
        items.append((key, int(size)))
    truncated = root.find('.//{http://doc.s3.amazonaws.com/2006-03-01}IsTruncated')
    next_marker = root.find('.//{http://doc.s3.amazonaws.com/2006-03-01}NextMarker')
    return items, (truncated is not None and truncated.text == 'true'), (next_marker.text if next_marker is not None else None)

print("=== Lee Lab bucket: search for fafb ===")
bucket = "lee-lab_brain-and-nerve-cord-fly-connectome"
# Try different prefixes
for prefix in ["compiled_data/fafb", "compiled_data/flywire", "fafb"]:
    items, trunc, nm = list_gcs(bucket, prefix, max_keys=30)
    if items:
        print(f"\n  Prefix '{prefix}' ({len(items)} items, truncated={trunc}):")
        for key, size in items[:20]:
            print(f"    {key} ({size/1e6:.1f}MB)")
        break
else:
    print("  No fafb prefix found. Listing all top-level prefixes...")
    # List with delimiter to get prefixes
    url = f"https://storage.googleapis.com/{bucket}?prefix=compiled_data/&delimiter=/&max-keys=50"
    r = urllib.request.urlopen(url, timeout=15)
    content = r.read().decode('utf-8')
    root = ET.fromstring(content)
    for cp in root.findall('.//{http://doc.s3.amazonaws.com/2006-03-01}CommonPrefixes'):
        p = cp.find('{http://doc.s3.amazonaws.com/2006-03-01}Prefix')
        if p is not None:
            print(f"    {p.text}")

print("\n=== Zenodo: hemibrain connectome records ===")
try:
    r = urllib.request.urlopen("https://zenodo.org/api/records?q=hemibrain+connectome&size=5", timeout=15)
    data = json.loads(r.read().decode('utf-8'))
    for hit in data.get('hits', {}).get('hits', []):
        print(f"  [{hit.get('id')}] {hit.get('title', 'N/A')[:80]}")
        print(f"    License: {hit.get('metadata', {}).get('license', {}).get('id', 'N/A')}")
        for f in hit.get('files', [])[:3]:
            print(f"    File: {f.get('key', 'N/A')} ({f.get('size', 0)/1e6:.1f}MB)")
            print(f"      Link: {f.get('links', {}).get('self', 'N/A')}")
except Exception as e:
    print(f"  Error: {e}")

print("\n=== Zenodo: flywire connectome ===")
try:
    r = urllib.request.urlopen("https://zenodo.org/api/records?q=flywire+connectome+edgelist&size=5", timeout=15)
    data = json.loads(r.read().decode('utf-8'))
    for hit in data.get('hits', {}).get('hits', []):
        print(f"  [{hit.get('id')}] {hit.get('title', 'N/A')[:80]}")
        for f in hit.get('files', [])[:3]:
            print(f"    File: {f.get('key', 'N/A')} ({f.get('size', 0)/1e6:.1f}MB)")
except Exception as e:
    print(f"  Error: {e}")
