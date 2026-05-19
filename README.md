# TripFuel

TripFuel is a local web editor for building vehicle usage records from fuel details. It uses AMap Web Service APIs to match destinations and calculate driving distances, then exports an Excel workbook with a vehicle usage detail sheet.

## Features

- Fixed origin for vehicle trips.
- Manual destination search and confirmation through AMap POI search.
- Optional waypoints, with segment distance display.
- Local Jilin Changchun 92# gasoline price table.
- Fuel detail maintenance tab.
- Auto-generate vehicle usage records by fuel interval.
- Excel export from the browser.

## Security Notice

Do not commit your AMap key to GitHub.

This project reads the key from either:

- the `AMAP_KEY` environment variable on the server, or
- the temporary key input in the browser page.

For public deployment, prefer server-side `AMAP_KEY` plus access control. If users type their own key in the browser, it is visible to that browser and is sent to this server in request headers.

## Local Setup

```bash
python -m venv .venv
```

Windows PowerShell:

```powershell
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:AMAP_KEY="your_amap_web_service_key"
python app.py
```

Linux/macOS:

```bash
source .venv/bin/activate
pip install -r requirements.txt
export AMAP_KEY="your_amap_web_service_key"
python app.py
```

Open:

```text
http://127.0.0.1:8000
```

## Server Deployment

Run with Uvicorn:

```bash
export AMAP_KEY="your_amap_web_service_key"
uvicorn app:app --host 0.0.0.0 --port 8000
```

For public servers, run it behind Nginx or another reverse proxy and add HTTPS plus authentication.

Recommended production pattern:

```bash
uvicorn app:app --host 127.0.0.1 --port 8000
```

Then reverse proxy external traffic to `127.0.0.1:8000`.

## Zeabur Deployment

This repository includes `zbpack.json` so Zeabur can use `app.py` as the Python entry file and install dependencies with `pip`.

1. Push the latest code to GitHub.
2. Open Zeabur and create a new project.
3. Choose **Deploy New Service** from GitHub.
4. Select `gui16789/tripFuel`.
5. Add service variable:

```text
AMAP_KEY=your_amap_web_service_key
```

6. Deploy the service.
7. In the service **Domain** page, generate or bind a public domain.

Zeabur injects `PORT` automatically. `app.py` reads `PORT` and binds to `0.0.0.0`, so no hard-coded cloud port is needed.

Important: the private source workbook `加油明细.xlsx` is ignored by Git. Without this file, route search and manual preview can still open, but fuel detail import/export and Excel export need a workbook template. For a private deployment, upload or mount your workbook on the server, or keep the deployment internal and commit a sanitized template workbook after removing private data.

## Required Local Data

The source workbook is intentionally not committed because it may contain private reimbursement data.

Place your workbook in the project root as:

```text
加油明细.xlsx
```

Generated drafts and exports are also ignored by Git.

## Ignored Sensitive Files

The repository ignores:

- `.env` and local secret files
- `*.xlsx` business workbooks and exports
- local generated drafts
- AMap cache files
- destination pool JSON files

Before pushing, you can scan for accidental keys:

```bash
rg -n "AMAP_KEY|key=|your_amap|[a-f0-9]{32}" .
```

## Useful Commands

Check Python syntax:

```bash
python -m py_compile app.py generate_vehicle_usage.py oil_price_fetcher.py
```

Check frontend JavaScript syntax:

```bash
node --check web/app.js
```
