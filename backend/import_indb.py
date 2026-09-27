#!/usr/bin/env python3
"""
Import the Indian Nutrient Databank recipes into the food table.

The spreadsheet's exact column names are not guaranteed, so this detects them
by fuzzy matching and prints what it found. Nothing is written until you
confirm.

Usage:
    pip install pandas openpyxl httpx --break-system-packages
    python import_indb.py recipes.xlsx
"""

import os
import re
import sys

import httpx
import pandas as pd
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_SECRET = os.environ.get("SUPABASE_SECRET_KEY")

# Candidate substrings for each field we need, most specific first.
WANTED = {
    "name":      ["food_name", "recipe_name", "recipename", "dish", "name"],
    "kcal":      ["energy_kcal", "energy (kcal)", "kcal", "energy"],
    "protein_g": ["protein"],
    "carb_g":    ["carbohydrate", "carbs", "cho"],
    "fat_g":     ["fat"],
    "fibre_g":   ["fibre", "fiber"],
    "serving_g": ["serving_size", "servingsize", "serving (g)", "serving", "portion"],
}


def pick_column(columns, candidates):
    lowered = {c: re.sub(r"[^a-z0-9]", "", str(c).lower()) for c in columns}
    for candidate in candidates:
        target = re.sub(r"[^a-z0-9]", "", candidate.lower())
        for original, flat in lowered.items():
            if flat == target:
                return original
    for candidate in candidates:
        target = re.sub(r"[^a-z0-9]", "", candidate.lower())
        for original, flat in lowered.items():
            if target in flat:
                return original
    return None


def to_number(value):
    if pd.isna(value):
        return None
    text = re.sub(r"[^0-9.\-]", "", str(value))
    try:
        return round(float(text), 2)
    except ValueError:
        return None


def main(path):
    if not SUPABASE_URL or not SUPABASE_SECRET:
        sys.exit("Set SUPABASE_URL and SUPABASE_SECRET_KEY in backend/.env first.")

    frame = pd.read_excel(path)
    print(f"\nRead {len(frame)} rows.\n")
    print("Columns found in the file:")
    for column in frame.columns:
        print(f"  {column}")

    mapping = {field: pick_column(frame.columns, options) for field, options in WANTED.items()}

    print("\nDetected mapping:")
    for field, column in mapping.items():
        print(f"  {field:10s} <- {column or 'NOT FOUND'}")

    if not mapping["name"]:
        sys.exit("\nCould not find a name column. Edit WANTED at the top of this script.")

    missing = [f for f in ("kcal", "protein_g", "carb_g", "fat_g") if not mapping[f]]
    if missing:
        print(f"\nWarning: no column matched for {', '.join(missing)}. Those will be null.")

    rows = []
    seen = set()

    for _, record in frame.iterrows():
        name = str(record[mapping["name"]]).strip()
        if not name or name.lower() == "nan":
            continue

        key = name.lower()
        if key in seen:
            continue
        seen.add(key)

        per_100g = {}
        for field in ("kcal", "protein_g", "carb_g", "fat_g", "fibre_g"):
            column = mapping[field]
            if not column:
                continue
            value = to_number(record[column])
            if value is not None:
                per_100g[field] = value

        rows.append({
            "name": name,
            "aliases": [],
            "is_dish": True,
            "source": "indb",
            "verified": True,
            "per_100g": per_100g,
            "serving_g": to_number(record[mapping["serving_g"]]) if mapping["serving_g"] else None,
        })

    print(f"\nPrepared {len(rows)} unique foods. First three:\n")
    for row in rows[:3]:
        print(f"  {row['name']}  {row['per_100g']}  serving={row['serving_g']}")

    if input("\nInsert these into the food table? [y/N] ").strip().lower() != "y":
        sys.exit("Nothing written.")

    headers = {
        "apikey": SUPABASE_SECRET,
        "Authorization": f"Bearer {SUPABASE_SECRET}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }

    inserted = 0
    with httpx.Client(timeout=60) as client:
        for start in range(0, len(rows), 200):
            batch = rows[start:start + 200]
            resp = client.post(f"{SUPABASE_URL}/rest/v1/food", headers=headers, json=batch)
            if resp.status_code >= 400:
                sys.exit(f"\nInsert failed at row {start}: {resp.text}")
            inserted += len(batch)
            print(f"  inserted {inserted}/{len(rows)}")

    print("\nDone.")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("Usage: python import_indb.py recipes.xlsx")
    main(sys.argv[1])

