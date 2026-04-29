
import requests
import sys

def verify_github_download(url):
    print(f"Verifying download from: {url}")
    try:
        # Use stream=True to avoid downloading the whole file if we just want to peek
        with requests.get(url, stream=True, timeout=10) as r:
            # Check status code
            if r.status_code != 200:
                print(f"Error: Status code {r.status_code}")
                return False
            
            # Check headers
            content_type = r.headers.get("Content-Type", "Unknown")
            content_length = r.headers.get("Content-Length", "Unknown")
            print(f"Content-Type: {content_type}")
            print(f"Content-Length: {content_length}")
            
            # Check content (first 16 bytes)
            first_chunk = next(r.iter_content(chunk_size=16), b"")
            print(f"First 16 bytes (Hex): {first_chunk.hex()}")
            
            # Heuristic check: does it look like HTML?
            if b"<!DOCTYPE html>" in first_chunk or b"<html" in first_chunk:
                print("Error: Content appears to be HTML (likely a 404 page or login page)")
                return False
                
            print("Verification Successful!")
            return True
            
    except Exception as e:
        print(f"Exception: {e}")
        return False

if __name__ == "__main__":
    # Example URL (replace with a real release asset URL)
    # This is a dummy URL for demonstration. 
    # In real usage, use a raw link like "https://github.com/User/Repo/releases/download/v1.0/firmware.bin"
    test_url = "https://raw.githubusercontent.com/Riken0321/Magos/main/README.md" 
    
    if len(sys.argv) > 1:
        test_url = sys.argv[1]
        
    verify_github_download(test_url)
