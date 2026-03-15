# Frontend Metadata & Settings Edits

> [!IMPORTANT]
> The application uses a **Partial Update (PATCH)** strategy for saving changes. The frontend MUST NEVER send the entire object back to the server.

## 1. Partial Update Strategy

When a user edits an item (e.g., changes the Title or View Settings), the frontend must track *only* the modified fields. On save, it constructs a payload containing only the Item ID and the changed properties.

**Why?**
- Prevents "stale data" bugs where opening a modal with incomplete data (e.g., missing titles) and saving would otherwise overwrite valid database fields with null/fallback values.
- Enables the backend to implement "Automatic Locking" by inferring user intent from the presence of specific fields in the payload.

## 2. Payload Examples

### Scenario A: User Renames a Movie
The user changes the title from "Terminator" to "The Terminator".

**Payload:**
```json
{
  "id": "123e4567-e89b-12d3-a456-426614174000",
  "title": "The Terminator"
}
```

### Scenario B: User Changes View Settings
The user changes the layout of a folder. Metadata (Title, Overview) is untouched.

**Payload:**
```json
{
  "id": "987fcdeb-51a2-43c1-z789-123456789000",
  "viewSettings": {
    "layout": "list"
  }
}
```

### Scenario C: Explicit Unlock
The user wants to revert a custom title to the scraper default. They click an "Unlock" or "Revert" button.

**Payload:**
```json
{
  "id": "123e4567-e89b-12d3-a456-426614174000",
  "lockedFields": {
    "title": false
  }
}
```
