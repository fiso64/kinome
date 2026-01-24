import json
import sqlite3
import hashlib
import os
import sys
import re

# Configuration
JSON_DB_PATH = os.path.join("test", "media-browser-test-lib", ".library", "database.json")
SQLITE_DB_PATH = os.path.join("test", "media-browser-test-lib", ".library", "library.db")
SCHEMA_TS_PATH = os.path.join("src", "main", "database", "schema.ts")

def get_schema_sql():
    if not os.path.exists(SCHEMA_TS_PATH):
        print(f"Error: Schema file not found at {SCHEMA_TS_PATH}")
        sys.exit(1)
        
    with open(SCHEMA_TS_PATH, 'r', encoding='utf-8') as f:
        content = f.read()
        
    # Extract content between backticks using regex
    match = re.search(r"export const SCHEMA_SQL = `(.*?)`", content, re.DOTALL)
    if match:
        return match.group(1)
    else:
        print("Error: Could not extract SCHEMA_SQL from schema.ts")
        sys.exit(1)

def generate_id(relative_path):
    return hashlib.sha256(relative_path.encode('utf-8')).hexdigest()

def init_db():
    # Always delete old DB to ensure schema changes are applied
    if os.path.exists(SQLITE_DB_PATH):
        print(f"Database found at {SQLITE_DB_PATH}. Deleting to start fresh...")
        try:
            os.remove(SQLITE_DB_PATH)
        except PermissionError:
            print("Error: Database is locked. Please close the app and try again.")
            sys.exit(1)
    
    conn = sqlite3.connect(SQLITE_DB_PATH)
    cursor = conn.cursor()
    
    schema_sql = get_schema_sql()
    cursor.executescript(schema_sql)
        
    conn.commit()
    return conn

def safe_json(obj):
    return json.dumps(obj) if obj else None

def migrate_node(cursor, node, parent_id, root_path_override=None):
    raw_path = node.get("path", "")
    
    if parent_id is None:
        relative_path = "."
        item_id = generate_id(".")
    else:
        relative_path = raw_path
        # Force regeneration of ID to ensure it matches the Node.js scanner logic exactly.
        # This prevents "phantom" items if the JSON ID differs from the calculated hash.
        item_id = generate_id(relative_path)

    item_type = node.get("type", "file")
    
    print(f"Migrating: {relative_path} ({item_type})")
    
    try:
        cursor.execute("""
            INSERT OR IGNORE INTO items (
                id, parent_id, path, name, type, 
                size, mtime, birthtime, 
                is_hidden, is_missing, is_user_edited, added_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            item_id,
            parent_id,
            relative_path,
            node.get("name"),
            item_type,
            node.get("size", 0),
            node.get("mtime", 0),
            node.get("birthtime", 0),
            1 if node.get("isHidden") else 0,
            1 if node.get("isMissing") else 0,
            1 if node.get("isUserEdited") else 0,
            node.get("addedAt", 0)
        ))
    except sqlite3.IntegrityError as e:
        print(f"Skipping duplicate/invalid item {relative_path}: {e}")
        return

    if node.get("tmdbId") or node.get("title") or node.get("mediaType"):
        images = {
            "poster": node.get("posterPath"),
            "backdrop": node.get("backdropPath"),
            "logo": node.get("logoPath")
        }
        
        cursor.execute("""
            INSERT OR REPLACE INTO metadata (
                item_id, tmdb_id, media_type, title, original_title, overview,
                release_date, year, season_number, episode_number,
                images_json, genres_json, tags_json, virtual_tags_json, people_json,
                seasons_json, episodes_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            item_id,
            node.get("tmdbId"),
            node.get("mediaType"),
            node.get("title"),
            node.get("originalTitle"),
            node.get("overview"),
            node.get("releaseDate"),
            node.get("year"),
            node.get("seasonNumber"),
            node.get("episodeNumber"),
            json.dumps(images),
            json.dumps(node.get("genres", [])),
            json.dumps(node.get("tags", {})),
            json.dumps(node.get("virtualTags", {})),
            json.dumps(node.get("tmdbCredits", None)),
            json.dumps(node.get("tmdbSeasons", None)),
            json.dumps(node.get("tmdbEpisodes", None))
        ))

    if node.get("watched") or node.get("lastWatched"):
        cursor.execute("""
            INSERT OR REPLACE INTO user_state (item_id, watched, last_watched_at)
            VALUES (?, ?, ?)
        """, (
            item_id,
            1 if node.get("watched") else 0,
            node.get("lastWatched")
        ))

    view_keys = ["layout", "clickAction", "gridPosterSize", "listDescriptionRows", "groupBy"]
    scraper_keys = ["retrieve_children_metadata", "children_type_hint", "process_tv_children"]
    
    view_settings = {k: node[k] for k in view_keys if k in node}
    scraper_settings = {k: node[k] for k in scraper_keys if k in node}
    
    if view_settings or scraper_settings:
        cursor.execute("""
            INSERT OR REPLACE INTO folder_settings (item_id, view_settings_json, scraper_settings_json)
            VALUES (?, ?, ?)
        """, (
            item_id,
            json.dumps(view_settings),
            json.dumps(scraper_settings)
        ))

    children = node.get("children", [])
    for child in children:
        migrate_node(cursor, child, item_id)

def main():
    if not os.path.exists(JSON_DB_PATH):
        print(f"Error: Source database not found at {JSON_DB_PATH}")
        return

    print("Loading JSON database...")
    with open(JSON_DB_PATH, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    root_node = data.get("root")
    if not root_node:
        print("Error: Invalid JSON database (no root node)")
        return

    conn = init_db()
    cursor = conn.cursor()
    
    print("Starting migration...")
    cursor.execute("BEGIN TRANSACTION")
    try:
        migrate_node(cursor, root_node, None)
        conn.commit()
        print("Migration complete. Run 'VACUUM' to optimize.")
        conn.execute("VACUUM")
    except Exception as e:
        print(f"Migration failed: {e}")
        conn.rollback()
    finally:
        conn.close()

if __name__ == "__main__":
    main()