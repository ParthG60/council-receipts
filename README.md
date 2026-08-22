# Council Receipts

What your council talks about, and where the money goes. 15 English councils across the political spectrum — pick one, see what it discusses (Council Gateway API minutes, FY2024-25), where its budget goes (MHCLG Revenue Outturn 2024-25, gross expenditure), and how it compares on a 5-metric scorecard.

Built at the Campaign Lab council-data hack day, 22 August 2026.

- Static site, no build step: `python -m http.server 8600` and open localhost:8600.
- `build.py` bakes `data.json` from the upstream CSVs (harvest + finance pipeline lives outside this repo).
- Full methodology is in the site footer's Methodology panel.

Sources: MHCLG · ONS · DfE · DESNZ · DfT · Council Gateway (Poteris) · Democracy Club. All open data.
