#!/usr/bin/env python3
"""
Streaming Performance Benchmark for Kinome Server

Tests:
1. Initial connection latency (time to first byte)
2. Throughput (MB/s) - Uses Persistent Connections (Keep-Alive)
3. Seek latency (random range requests)
4. Concurrent connection handling
"""

import time
import requests
import statistics
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import random

# Configuration
BASE_URL = "http://localhost:3000"
# Ensure this matches your actual file path/ID
STREAM_PATH = "/api/stream/f0026d2746be66aa955852b75d450fed913221c85644482665cc0bab111573e9/Perfect.Blue.1997.2160p.UHD.Blu-ray.Remux.SDR.HEVC.TrueHD.5.1-CiNEPHiLES.mkv"
STREAM_URL = BASE_URL + STREAM_PATH

# Test parameters
CHUNK_SIZES = [1 * 1024 * 1024, 10 * 1024 * 1024, 100 * 1024 * 1024]  # 1MB, 10MB, 100MB
NUM_LATENCY_TESTS = 20
NUM_SEEK_TESTS = 10
CONCURRENT_CONNECTIONS = [1, 5, 10]

# Global session for persistent connections
session = requests.Session()

def get_file_size():
    """Get total file size from server"""
    try:
        resp = session.get(STREAM_URL, headers={"Range": "bytes=0-0"}, timeout=10)
        content_range = resp.headers.get('Content-Range', '')
        if content_range:
            total = int(content_range.split('/')[-1])
            return total
        return None
    except Exception as e:
        print(f"Error getting file size: {e}")
        return None


def test_latency(num_tests=NUM_LATENCY_TESTS):
    """Test time to first byte (TTFB)"""
    print(f"\n{'='*60}")
    print("TEST 1: Time to First Byte (TTFB)")
    print(f"{'='*60}")
    
    latencies = []
    
    # We use a new session here to measure handshake + response time, 
    # or strictly the response time if we reuse. 
    # For pure server latency, reusing session is better.
    
    for i in range(num_tests):
        start = time.perf_counter()
        try:
            resp = session.get(STREAM_URL, headers={"Range": "bytes=0-0"}, timeout=10)
            _ = resp.content[:1]  # Force read
            elapsed = (time.perf_counter() - start) * 1000  # ms
            latencies.append(elapsed)
        except Exception as e:
            print(f"  Error in test {i+1}: {e}")
    
    if latencies:
        print(f"  Samples: {len(latencies)}")
        print(f"  Min:     {min(latencies):.2f} ms")
        print(f"  Max:     {max(latencies):.2f} ms")
        print(f"  Mean:    {statistics.mean(latencies):.2f} ms")
        print(f"  Median:  {statistics.median(latencies):.2f} ms")
        if len(latencies) > 1:
            print(f"  Stdev:   {statistics.stdev(latencies):.2f} ms")
    
    return latencies


def test_throughput(chunk_size, file_size):
    """Test throughput for a specific chunk size"""
    max_start = max(0, file_size // 2 - chunk_size)
    start_byte = random.randint(0, max_start) if max_start > 0 else 0
    end_byte = start_byte + chunk_size - 1
    
    start = time.perf_counter()
    try:
        resp = session.get(
            STREAM_URL, 
            headers={"Range": f"bytes={start_byte}-{end_byte}"},
            timeout=60
        )
        data = resp.content
        elapsed = time.perf_counter() - start
        
        actual_size = len(data)
        throughput_mbps = (actual_size / 1024 / 1024) / elapsed
        return throughput_mbps, actual_size, elapsed
    except Exception as e:
        print(f"  Error: {e}")
        return None, 0, 0


def test_throughput_suite(file_size):
    """Run throughput tests for various chunk sizes"""
    print(f"\n{'='*60}")
    print("TEST 2: Throughput (Sequential Reads / Keep-Alive)")
    print(f"{'='*60}")
    
    for chunk_size in CHUNK_SIZES:
        chunk_mb = chunk_size / 1024 / 1024
        print(f"\n  Chunk Size: {chunk_mb:.0f} MB")
        
        throughputs = []
        for i in range(5):
            result = test_throughput(chunk_size, file_size)
            if result[0]:
                throughputs.append(result[0])
                print(f"    Sample {i+1}: {result[0]:.1f} MB/s ({result[2]:.2f}s)")
        
        if throughputs:
            print(f"  → Average: {statistics.mean(throughputs):.1f} MB/s")


def test_seek_latency(file_size, num_tests=NUM_SEEK_TESTS):
    """Test latency for random seek operations"""
    print(f"\n{'='*60}")
    print("TEST 3: Seek Latency (Random Range Requests)")
    print(f"{'='*60}")
    
    latencies = []
    
    for i in range(num_tests):
        pos = random.randint(0, file_size - 1024)
        
        start = time.perf_counter()
        try:
            resp = session.get(
                STREAM_URL,
                headers={"Range": f"bytes={pos}-{pos+1023}"},
                timeout=10
            )
            _ = resp.content
            elapsed = (time.perf_counter() - start) * 1000
            latencies.append(elapsed)
        except Exception as e:
            print(f"  Error in seek test {i+1}: {e}")
    
    if latencies:
        print(f"  Samples: {len(latencies)}")
        print(f"  Min:     {min(latencies):.2f} ms")
        print(f"  Max:     {max(latencies):.2f} ms")
        print(f"  Mean:    {statistics.mean(latencies):.2f} ms")
        print(f"  Median:  {statistics.median(latencies):.2f} ms")
    
    return latencies


def concurrent_request(file_size):
    """Single concurrent request helper"""
    # Each thread needs its own session to simulate distinct clients,
    # otherwise requests isn't thread-safe or will block on the single connection.
    thread_session = requests.Session()
    
    chunk_size = 10 * 1024 * 1024  # 10MB
    start_byte = random.randint(0, max(0, file_size - chunk_size))
    end_byte = start_byte + chunk_size - 1
    
    start = time.perf_counter()
    try:
        resp = thread_session.get(
            STREAM_URL,
            headers={"Range": f"bytes={start_byte}-{end_byte}"},
            timeout=30
        )
        data = resp.content
        elapsed = time.perf_counter() - start
        throughput = (len(data) / 1024 / 1024) / elapsed
        thread_session.close()
        return throughput
    except Exception as e:
        thread_session.close()
        return 0


def test_concurrent_connections(file_size):
    """Test performance under concurrent load"""
    print(f"\n{'='*60}")
    print("TEST 4: Concurrent Connections")
    print(f"{'='*60}")
    
    for num_concurrent in CONCURRENT_CONNECTIONS:
        print(f"\n  Concurrent Clients: {num_concurrent}")
        
        with ThreadPoolExecutor(max_workers=num_concurrent) as executor:
            futures = [
                executor.submit(concurrent_request, file_size)
                for _ in range(num_concurrent)
            ]
            
            throughputs = []
            for future in as_completed(futures):
                result = future.result()
                if result > 0:
                    throughputs.append(result)
        
        if throughputs:
            total_throughput = sum(throughputs)
            avg_per_client = statistics.mean(throughputs)
            print(f"    Total Throughput: {total_throughput:.1f} MB/s")
            print(f"    Per-Client Avg:   {avg_per_client:.1f} MB/s")


def test_open_ended_range(file_size):
    print(f"\n{'='*60}")
    print("TEST 5: Open-Ended Range Handling")
    print(f"{'='*60}")
    
    start = time.perf_counter()
    try:
        resp = session.get(
            STREAM_URL,
            headers={"Range": "bytes=0-"},
            timeout=30,
            stream=True
        )
        
        next(resp.iter_content(1024*1024))
        elapsed = (time.perf_counter() - start) * 1000
        
        print(f"  Response Status: {resp.status_code}")
        print(f"  Time to 1MB:     {elapsed:.2f} ms")
        
        resp.close()
    except Exception as e:
        print(f"  Error: {e}")


def run_all_tests():
    print("\n" + "="*60)
    print("KINOME STREAMING BENCHMARK (Persistent Sessions)")
    print("="*60)
    print(f"Server: {BASE_URL}")
    print(f"Stream: {STREAM_PATH[:50]}...")
    
    file_size = get_file_size()
    if not file_size:
        print("\nERROR: Could not determine file size.")
        return
    
    print(f"File Size: {file_size / 1024 / 1024 / 1024:.2f} GB")
    
    test_latency()
    test_throughput_suite(file_size)
    test_seek_latency(file_size)
    test_concurrent_connections(file_size)
    test_open_ended_range(file_size)
    
    print("\n" + "="*60)
    print("BENCHMARK COMPLETE")
    print("="*60 + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--quick", action="store_true")
    args = parser.parse_args()
    
    if args.quick:
        file_size = get_file_size()
        if file_size:
            test_latency(5)
    else:
        run_all_tests()