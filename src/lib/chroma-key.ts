export const RGB_LUMA_WEIGHTS = [0.2126, 0.7152, 0.0722] as const;

export type RgbColor = readonly [number, number, number];

export function getKeyColorChroma(keyColor: RgbColor) {
  const luminance = keyColor[0] * RGB_LUMA_WEIGHTS[0]
    + keyColor[1] * RGB_LUMA_WEIGHTS[1]
    + keyColor[2] * RGB_LUMA_WEIGHTS[2];
  const vector: [number, number, number] = [
    keyColor[0] - luminance,
    keyColor[1] - luminance,
    keyColor[2] - luminance,
  ];
  const magnitudeSquared = vector[0] ** 2 + vector[1] ** 2 + vector[2] ** 2;
  return { vector, magnitudeSquared };
}

export function createMatteAwareSpillFilter(keyColor: RgbColor, strength: number) {
  const { vector, magnitudeSquared } = getKeyColorChroma(keyColor);
  if (magnitudeSquared < 0.001 || strength <= 0) return null;

  const channels = ["r(X,Y)", "g(X,Y)", "b(X,Y)"] as const;
  const format = (value: number) => value.toFixed(8);
  const luminance = `(${channels[0]}*${RGB_LUMA_WEIGHTS[0]}+${channels[1]}*${RGB_LUMA_WEIGHTS[1]}+${channels[2]}*${RGB_LUMA_WEIGHTS[2]})`;
  const projection = `max(0,((${channels[0]}-${luminance})*${format(vector[0])}+(${channels[1]}-${luminance})*${format(vector[1])}+(${channels[2]}-${luminance})*${format(vector[2])})/${format(magnitudeSquared)})`;
  const correctionLimits = vector.map((component, index) => {
    if (component > 0) return `(${channels[index]}/${format(component)})`;
    if (component < 0) return `((255-${channels[index]})/${format(-component)})`;
    return "1e9";
  });
  const maxCorrection = `min(${correctionLimits[0]},min(${correctionLimits[1]},${correctionLimits[2]}))`;
  const alpha = "(alpha(X,Y)/255)";
  const edgeWeight = `4*${alpha}*(1-${alpha})`;
  const correction = `min(${projection}*${format(strength)}*${edgeWeight},${maxCorrection})`;
  const outputNames = ["r", "g", "b"] as const;
  const output = channels.map((channel, index) => (
    `${outputNames[index]}='clip(${channel}-${format(vector[index])}*${correction},0,255)'`
  ));

  return `format=gbrap,geq=${output.join(":")}:a='alpha(X,Y)',format=rgba`;
}
