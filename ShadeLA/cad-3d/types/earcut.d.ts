declare module 'earcut' {
  export default function earcut(
    data: number[] | Float32Array | Float64Array,
    holeIndices?: number[] | null,
    dim?: number
  ): number[];
}
