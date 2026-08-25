# Council Receipts

What your council talks about, and where the money goes. 282 English councils across the political spectrum — pick one, see what it discusses (Council Gateway API minutes, FY2024-25), where its budget goes (MHCLG Revenue Outturn 2024-25, gross expenditure with population-weighted England averages), and how it compares on a 7-metric Quality of Life scorecard and financial distress check.

Built at Campaign Lab hack day, August 2026.

- Static site, no build step: `python -m http.server 8600` and open localhost:8600.
- `build.py` bakes `data.json` from upstream open data CSVs across all 282 local authorities.
- Full methodology is in the site footer's Methodology panel.

Sources: MHCLG · ONS · DfE · Defra/OHID · DWP · Nomis · Council Gateway (Poteris) · Democracy Club · Open Council Data UK. All open data.
