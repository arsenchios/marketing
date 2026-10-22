export type CameraBox = { x: number; y: number; width: number };
export const defaultCameraBox: CameraBox = { x: 0.76, y: 0.74, width: 0.21 };
export function fitCameraBox(b: CameraBox): CameraBox {
  const width = Math.max(0.12, Math.min(0.55, b.width));
  return {
    width,
    x: Math.max(0, Math.min(1 - width, b.x)),
    y: Math.max(0, Math.min(1 - width, b.y)),
  };
}
