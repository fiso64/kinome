import os
import time
import shutil
from pathlib import Path

def get_mtime(path):
    return os.path.getmtime(path)

def test_mtime():
    sandbox = Path("mtime_sandbox")
    if sandbox.exists():
        shutil.rmtree(sandbox)
    sandbox.mkdir()
    
    parent = sandbox / "Parent"
    parent.mkdir()
    
    # Give the system a moment to settle timestamps
    time.sleep(0.1)
    
    print(f"--- Testing mtime behavior on {os.name} ---")
    
    # 1. ADDING ITEM
    base_mtime = get_mtime(parent)
    time.sleep(0.1)
    (parent / "new_file.txt").touch()
    post_add_file = get_mtime(parent)
    print(f"Add File:    {'CHANGED' if post_add_file > base_mtime else 'NO CHANGE'} ({base_mtime} -> {post_add_file})")

    time.sleep(0.1)
    (parent / "new_folder").mkdir()
    post_add_folder = get_mtime(parent)
    print(f"Add Folder:  {'CHANGED' if post_add_folder > post_add_file else 'NO CHANGE'} ({post_add_file} -> {post_add_folder})")

    # 2. REMOVING ITEM
    time.sleep(0.1)
    (parent / "new_file.txt").unlink()
    post_remove_file = get_mtime(parent)
    print(f"Remove File: {'CHANGED' if post_remove_file > post_add_folder else 'NO CHANGE'} ({post_add_folder} -> {post_remove_file})")

    time.sleep(0.1)
    (parent / "new_folder").rmdir()
    post_remove_folder = get_mtime(parent)
    print(f"Remove Folder: {'CHANGED' if post_remove_folder > post_remove_file else 'NO CHANGE'} ({post_remove_file} -> {post_remove_folder})")

    # 3. MODIFYING ITEM (CONTENT)
    target = parent / "mod.txt"
    target.touch()
    time.sleep(0.1)
    pre_mod = get_mtime(parent)
    time.sleep(0.1)
    with open(target, "a") as f:
        f.write("change")
    post_mod = get_mtime(parent)
    print(f"Modify File Content (Parent View): {'CHANGED' if post_mod > pre_mod else 'NO CHANGE'} ({pre_mod} -> {post_mod})")

    # 4. MODIFYING ITEM (RENAME)
    time.sleep(0.1)
    pre_rename = get_mtime(parent)
    time.sleep(0.1)
    target.rename(parent / "renamed.txt")
    post_rename = get_mtime(parent)
    print(f"Rename File (Parent View): {'CHANGED' if post_rename > pre_rename else 'NO CHANGE'} ({pre_rename} -> {post_rename})")

    # 5. RECURSIVE CHANGE (DEEP)
    sub = parent / "SubFolder"
    sub.mkdir()
    sub_file = sub / "deep.txt"
    sub_file.touch()
    time.sleep(0.1)
    
    parent_pre_deep = get_mtime(parent)
    sub_pre_deep = get_mtime(sub)
    
    time.sleep(0.1)
    with open(sub_file, "a") as f:
        f.write("deep change")
        
    parent_post_deep = get_mtime(parent)
    sub_post_deep = get_mtime(sub)
    
    print("\n--- Deep Change (Parent/SubFolder/deep.txt) ---")
    print(f"SubFolder mtime: {'CHANGED' if sub_post_deep > sub_pre_deep else 'NO CHANGE'}")
    print(f"Parent mtime:    {'CHANGED' if parent_post_deep > parent_pre_deep else 'NO CHANGE'} (Suspected: NO CHANGE)")

    # Cleanup
    shutil.rmtree(sandbox)

if __name__ == "__main__":
    test_mtime()
