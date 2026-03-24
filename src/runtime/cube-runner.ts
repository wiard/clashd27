import { createCube, tickCube } from "../cube/cube-engine.ts"

// INIT
let cube = createCube(3)

console.log("Cube runner started")

// LOOP
setInterval(() => {
  cube = tickCube(cube)

  const center = cube.cells[13]

  console.log(
    "Cell 14 -> coherence:",
    center.coherence.toFixed(4),
    "phase:",
    center.phase.toFixed(4)
  )
}, 500)
