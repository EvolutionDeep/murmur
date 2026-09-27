"""Check accessibility of FlyWire/Hemibrain connectome data sources."""
import urllib.request
import urllib.error

def check_url(url, method='HEAD'):
    try:
        req = urllib.request.Request(url, method=method)
        r = urllib.request.urlopen(req, timeout=10)
        size = r.headers.get('Content-Length', 'unknown')
        print(f"  OK {r.status} size={size}: {url.split('/')[-1] or url}")
        return True
    except urllib.error.HTTPError as e:
        print(f"  {e.code} {e.reason}: {url.split('/')[-1] or url}")
    except Exception as e:
        print(f"  {type(e).__name__}: {url.split('/')[-1] or url} - {str(e)[:100]}")
    return False

print("=== Lee Lab FAFB (FlyWire) GCS bucket ===")
base_lee = "https://storage.googleapis.com/lee-lab_brain-and-nerve-cord-fly-connectome/compiled_data"
check_url(f"{base_lee}/fafb_783_simple_edgelist.feather")
check_url(f"{base_lee}/fafb_783_meta.feather")
check_url(f"{base_lee}/fafb_783_neuron_types.feather")

print("\n=== Try GCS XML API listing ===")
try:
    list_url = "https://storage.googleapis.com/lee-lab_brain-and-nerve-cord-fly-connectome?prefix=compiled_data/&max-keys=20"
    r = urllib.request.urlopen(list_url, timeout=10)
    content = r.read().decode('utf-8')
    print(f"  Listing response ({len(content)} bytes):")
    print(content[:3000])
except Exception as e:
    print(f"  Error: {e}")

print("\n=== Hemibrain (Janelia FlyEM) alternatives ===")
# Try various known paths
hemibrain_urls = [
    "https://storage.googleapis.com/janelia-cosem-datasets/hemibrain/v1.2.1/hemibrain_121_simple_edgelist.feather",
    "https://storage.googleapis.com/janelia-flyem-data/hemibrain/v1.2.1/hemibrain_121_simple_edgelist.feather",
    "https://hemibrain-dot-janelia-flyem.appspot.com/api/v1/connections",
]
for url in hemibrain_urls:
    check_url(url)

print("\n=== FlyWire public API ===")
check_url("https://api.flywire.ai/api/v1/connectome")
check_url("https://cave.flywire.ai/api/v1/materialization/projects/fafbv14/neuron_attributes/annotations/")

print("\n=== Zenodo / Figshare ===")
check_url("https://zenodo.org/api/records?q=hemibrain+connectome&size=5")
