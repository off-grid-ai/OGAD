#!/usr/bin/env node

// macOS screen-capture boundary for the hybrid E2E. It copies a synthetic
// frame into the exact output path requested by the production capture port.
import fs from 'node:fs'

fs.copyFileSync(process.env.OFFGRID_E2E_COMPUTER_USE_FRAME, process.argv[2])
