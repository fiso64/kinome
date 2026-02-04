#!/usr/bin/env python3
import os
import sys
import argparse

def mirror_structure(source_dir, target_dir):
    """
    Replicates the folder structure and file names from source_dir to target_dir,
    but creates empty (0-byte) files instead of copying content.
    """
    
    # Check if source exists
    if not os.path.exists(source_dir):
        print(f"Error: Source directory '{source_dir}' does not exist.")
        sys.exit(1)

    # Counters for statistics
    files_created = 0
    dirs_created = 0

    print(f"Mirroring structure from: {source_dir}")
    print(f"To: {target_dir}")
    print("-" * 40)

    # Walk through the directory tree
    for root, dirs, files in os.walk(source_dir):
        # Calculate the relative path from the source root
        # e.g., if source is /mnt/data and current root is /mnt/data/music/rock
        # rel_path becomes music/rock
        rel_path = os.path.relpath(root, source_dir)
        
        # Determine the corresponding destination directory
        dest_path = os.path.join(target_dir, rel_path)

        # Create the directory if it doesn't exist
        if not os.path.exists(dest_path):
            os.makedirs(dest_path)
            dirs_created += 1

        # Create empty files
        for filename in files:
            dest_file_path = os.path.join(dest_path, filename)
            
            # Create an empty file (overwrite if exists)
            try:
                # 'wb' ensures it is binary mode and empty
                with open(dest_file_path, 'wb') as f:
                    pass 
                files_created += 1
            except OSError as e:
                print(f"Failed to create {filename}: {e}")

    print("-" * 40)
    print(f"Operation complete.")
    print(f"Directories created: {dirs_created}")
    print(f"Empty files created: {files_created}")

if __name__ == "__main__":
    # Initialize argument parser
    parser = argparse.ArgumentParser(
        description="Recreate directory structure with empty files."
    )
    
    parser.add_argument("source", help="Path to the source media directory")
    parser.add_argument("target", help="Path to the output directory")

    args = parser.parse_args()

    # Convert paths to absolute paths for safety
    abs_source = os.path.abspath(args.source)
    abs_target = os.path.abspath(args.target)

    # Prevent running if source is inside target or vice versa to avoid recursion loops
    if abs_target.startswith(abs_source):
        print("Error: Target directory cannot be inside the source directory.")
        sys.exit(1)

    mirror_structure(abs_source, abs_target)