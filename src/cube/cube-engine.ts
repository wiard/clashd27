export type CellState = {
  id: number
  value: number
  phase: number
  coherence: number
  residue: number
}

export type CubeState = {
  size: number
  cells: CellState[]
}

export function createCube(size: number): CubeState {
  const total = size * size * size

  const cells: CellState[] = Array.from({ length: total }, (_, i) => ({
    id: i + 1,
    value: 0,
    phase: 0,
    coherence: 1,
    residue: 0
  }))

  return { size, cells }
}

export function tickCube(cube: CubeState): CubeState {
  const nextCells = cube.cells.map((cell) => {
    const noise = (Math.random() - 0.5) * 0.01

    return {
      ...cell,
      value: cell.value + noise,
      phase: cell.phase + 0.02,
      coherence: Math.max(0, Math.min(1, cell.coherence - Math.abs(noise))),
      residue: cell.residue * 0.98 + noise
    }
  })

  return {
    ...cube,
    cells: nextCells
  }
}
