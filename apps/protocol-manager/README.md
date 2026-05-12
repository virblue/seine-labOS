# Protocol Manager

Protocol Manager is the first app in Seine Lab OS (Viridian Blue Labs).

## Purpose

A scientist-friendly visual editor for building structured wet-lab protocols as portable, AI-compatible JSON.

## Features in this phase

- section/subsection/step outline editing
- typed step kinds (`action`, `preparation`, `qc`, `optional`, `pause`, `cleanup`, `analysis`)
- specialized block editors for:
  - recipe
  - timeline
  - qc
  - caution
  - link
- live preview panel
- import/export panel with JSON validation
- AI-assisted import instructions panel
- localStorage autosave

## Scripts

```bash
npm run dev
npm run build
npm run typecheck
```

## Publishing

This app is set up for GitHub Pages deployment at:

`https://virblue.github.io/seine-labOS/protocol-manager/`

The lab-wide home dashboard (Account app) owns the bare site root `https://virblue.github.io/seine-labOS/`. Protocol Manager itself mounts at `https://virblue.github.io/seine-labOS/protocol-manager/`.

The GitHub Actions workflow builds the app with `VITE_BASE_PATH=/seine-labOS/protocol-manager/` so the generated asset URLs work correctly when served from the repository project site path.

## Data model principles

- canonical JSON format
- stable IDs
- schema versioning (`1.0.0`)
- content/presentation separation
- unknown future data preserved under `extensions`
